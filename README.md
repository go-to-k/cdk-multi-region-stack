# cdk-multi-region-stack

A CDK `Stack` that can place some of its resources in **other regions**, while everything stays in **one logical stack** in your CDK app.

Typical use case: your application lives in `ap-northeast-1`, but the ACM certificate and WAF WebACL for your CloudFront distribution must live in `us-east-1`. Today you split them into separate stacks by hand. With `MultiRegionStack` you write them as one stack.

## Usage

### Install

```sh
npm install cdk-multi-region-stack
```

### CDK Code

The following code is a minimal example: the ACM certificate lives in `us-east-1` via `stack.regionScope('us-east-1')`, while the CloudFront distribution lives in the stack's own region (`ap-northeast-1`) and references that certificate across regions.

```ts
import { MultiRegionStack } from 'cdk-multi-region-stack';

const stack = new MultiRegionStack(app, 'MyApp', {
  env: { account: '123456789012', region: 'ap-northeast-1' },
});

// Lives in us-east-1
const cert = new acm.Certificate(stack.regionScope('us-east-1'), 'Cert', {
  domainName: 'example.com',
  validation: acm.CertificateValidation.fromDns(hostedZone),
});

// Lives in ap-northeast-1, references the us-east-1 certificate
new cloudfront.Distribution(stack, 'Dist', {
  defaultBehavior: { origin },
  domainNames: ['example.com'],
  certificate: cert,
});
```

You can also `extends MultiRegionStack` to keep the multi-region wiring inside your own stack class. Inside the class, `this` is the main-region scope and `this.regionScope('us-east-1')` is the other-region scope:

```ts
import { MultiRegionStack, MultiRegionStackProps } from 'cdk-multi-region-stack';
import { Construct } from 'constructs';

interface MyAppStackProps extends MultiRegionStackProps {
  readonly domainName: string;
  readonly hostedZone: route53.IHostedZone;
}

// A stack in ap-northeast-1
class MyAppStack extends MultiRegionStack {
  constructor(scope: Construct, id: string, props: MyAppStackProps) {
    super(scope, id, props);

    // Lives in us-east-1
    const cert = new acm.Certificate(this.regionScope('us-east-1'), 'Cert', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    // Lives in the stack's own region (ap-northeast-1), references the us-east-1 certificate
    new cloudfront.Distribution(this, 'Dist', {
      defaultBehavior: { origin },
      domainNames: [props.domainName],
      certificate: cert,
    });
  }
}

new MyAppStack(app, 'MyApp', {
  env: { account: '123456789012', region: 'ap-northeast-1' },
  domainName: 'example.com',
  hostedZone,
});
```

## How it works

At synth time this produces one CloudFormation stack per region, all with the **same stack name**, wired through CDK's built-in cross-region reference machinery (`crossRegionReferences: true` is enabled automatically).

- `stack.regionScope(region)` lazily creates a "twin" `Stack` — a sibling of your stack (under the same `App`/`Stage`) with the same `stackName`, targeting the same account in the given region. Constructs created in that scope deploy to that region.
- Because the main stack references twin values, the CDK CLI treats twins as upstream dependencies: **`cdk deploy MyApp` deploys the twins automatically**, twins first.
- Values crossing regions use CDK's export machinery. The reference strength (`strong` / `weak` / `both`) follows the `@aws-cdk/core:defaultCrossStackReferences` context flag (aws-cdk-lib >= 2.254.0). See [reference strength](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/README.md#reference-strength).

## Conditionally skipping a region

`regionScope(region)` creates the twin **lazily** — only on the first call for that region. So skipping a whole region is just a plain `if`: don't call `regionScope()` for it, and its twin is never synthesized. A common case is dropping the WAF WebACL (and therefore the `us-east-1` twin) in cheaper environments:

```ts
const skipUsEast1 = this.node.tryGetContext('ENV') === 'dev';

// Not calling regionScope('us-east-1') means no us-east-1 twin at all
let webAcl: wafv2.CfnWebACL | undefined;
if (!skipUsEast1) {
  webAcl = new wafv2.CfnWebACL(this.regionScope('us-east-1'), 'WebAcl', {
    scope: 'CLOUDFRONT',
    // ...
  });
}

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  webAclId: webAcl?.attrArn, // undefined when skipped: no WAF, no cross-region reference
  // ...
});
```

When the region is skipped, no cross-region reference is emitted and the main stack deploys on its own.

This is safe for a fresh deployment, or when environments use different stack names or accounts. **But if a twin was already deployed and you then flip the context to skip it, the twin is orphaned** — CDK never deletes a stack that disappeared from the app (see the caveat below). In that case destroy it first: `cdk destroy 'MyApp-us-east-1'`.

## Requirements and caveats

- **Concrete `env.region` required.** Region-agnostic stacks are rejected; the account may remain environment-agnostic (twins inherit it and resolve from credentials at deploy time).
- **Destroy with a wildcard.** CLI patterns match artifact IDs, and destroy does not follow upstream dependencies: use `cdk destroy 'MyApp*'` to remove the twins too. (`cdk deploy MyApp` needs no wildcard.)
- **Don't remove `regionScope()` calls while deployed.** Each twin keeps a no-op placeholder resource, so removing the *resources* in a region just empties the twin on next deploy. But if you remove the `regionScope()` call itself, the deployed twin stack is orphaned (CDK never deletes removed stacks) — destroy it first.
- **Dependency cycles across regions fail at synth.** A chain like A(us-east-1) → B(main) → C(us-east-1) is a stack-level cycle even though the resources form no cycle. Restructure (move a resource, or split a real second stack) if you hit `would create a cyclic reference`.
- **Region moves are replacements.** Moving a construct between region scopes moves it to a different stack: the resource is destroyed and recreated.

### Replacing a cross-region-referenced resource does not auto-propagate

This is the sharpest edge, and it is a limitation of CDK's cross-region reference machinery itself (you hit the same thing hand-splitting stacks with `crossRegionReferences`), not something this library adds. When a resource in one region is **replaced but keeps its logical ID** (a property change that forces replacement — new physical name / ARN), the consuming region does **not** automatically pick up the new value in any reference mode, verified end-to-end:

- **strong** (default): the cross-region export writer skips value-only updates (same key, new value), so the SSM export parameter keeps the old ARN and the consumer keeps referencing the deleted resource. This is a bug and is **fixable upstream** — a one-line writer fix restores propagation, because the reader's `{{resolve:ssm:...}}` dynamic reference re-resolves and forces a consumer changeset (verified by manually correcting the parameter). See [issue #1](https://github.com/go-to-k/cdk-multi-region-stack/issues/1).
- **weak**: the twin's `Output` correctly updates to the new ARN, but the consumer template embeds `Fn::GetStackOutput` literally and is byte-identical across the replacement, so CloudFormation does a **no-op** on the consumer (`SampleStack (no changes)`) and never re-resolves it. This is inherent to the weak mechanism, not a simple bug — weak is **worse** here than strong-once-fixed.

Workarounds if you must replace a referenced resource: rename the construct (new logical ID → the reference expression changes → propagates), or force a consumer-side change, or split into two deployments. In the flagship use case (ACM cert / WAF for CloudFront) these replacements are rare, and cert/WebACL usually can't be silently deleted while attached, so the failure tends to surface loudly rather than silently.

### The strong-reference deletion guarantee is not enforced (as of aws-cdk-lib 2.261.0)

- The documented strong-reference guarantee "the producing stack cannot be deleted while consumers exist" is currently **not enforced** (the in-use validation was removed in aws-cdk#38059). Deleting a twin alone succeeds and deletes the export parameters, breaking the consumer's next deploy. Use `cdk destroy 'MyApp*'` (destroy everything together) rather than destroying individual twins. See [issue #2](https://github.com/go-to-k/cdk-multi-region-stack/issues/2).

See [docs/FINDINGS.md](./docs/FINDINGS.md) for the full verification log behind these notes.
