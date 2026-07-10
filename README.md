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
  - **`strong` (default) adds a custom resource** on each side of every cross-region reference — an ExportWriter on the twin and an ExportReader on the main stack, each backed by a Lambda + role. If you'd rather not create those, opt into `weak`, which needs **zero extra infrastructure** (the value crosses via `Fn::GetStackOutput`, which embeds the twin's actual stack name — the shared name is a convention, not a requirement, so it works the same after a [stack-name override](#migrating-existing-differently-named-stacks)):

    ```ts
    const app = new App({
      context: { '@aws-cdk/core:defaultCrossStackReferences': 'weak' },
    });
    ```

    Or set it in `cdk.json` under `context`. Note that replacing a referenced resource does not auto-propagate under either strength.

## Resources that reference the main stack (groups)

Some resources must live in another region AND reference the main stack. The flagship example is a CloudWatch alarm on CloudFront metrics: the metrics only exist in `us-east-1`, and the alarm references the distribution ID in the main stack. Putting the alarm in the same twin as the ACM certificate makes references flow in **both directions** between the two stacks — a stack-level cyclic reference, rejected at synth. If the region holds nothing the main stack references — e.g. an alarm with no ACM certificate there — the reference is one-way and a plain `regionScope(region)` works without a group.

Put such resources in a **group**: an additional stack in that region.

```ts
// Lives in us-east-1, deploys BEFORE the main stack (the main stack references it)
const cert = new acm.Certificate(this.regionScope('us-east-1'), 'Cert', { ... });

const dist = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  certificate: cert,
  // ...
});

// Lives in us-east-1 too, deploys AFTER the main stack (it references the main stack)
new cw.Alarm(this.regionScope('us-east-1', { group: 'Alarms' }), 'Errors5xx', {
  metric: new cw.Metric({
    namespace: 'AWS/CloudFront',
    metricName: '5xxErrorRate',
    dimensionsMap: { DistributionId: dist.distributionId, Region: 'Global' },
  }),
  threshold: 1,
  evaluationPeriods: 1,
});
```

This synthesizes a linear chain of three stacks — twin (`MyApp` in us-east-1) → main (`MyApp`) → group (`MyApp-Alarms` in us-east-1) — and the deploy order is derived automatically from the references; no `addDependency` calls needed. If you hit the cyclic reference by putting both directions in one twin, the error message names the fix.

Details:

- The group's stack name is `<stackName>-<group>` — the same name in every region, extending the default twin's shared-name convention. The group name must start with a letter and contain only letters, digits and hyphens (it becomes part of the stack name).
- The same `(region, group)` pair always returns the same stack. A group in the stack's own region is allowed and creates a second main-region stack.
- **`cdk deploy MyApp` does NOT deploy groups that reference the main stack.** The CLI extends the selection to *dependencies* only, and such groups are dependents (downstream). Deploy with a wildcard: `cdk deploy 'MyApp*'`. A synth-time warning reminds you when a group (or twin) is not a dependency of the main stack; if the layout is intentional, acknowledge it with `Annotations.of(theStack).acknowledgeWarning('cdk-multi-region-stack:stackNotDeployedWithMainStack')`.
- Removing a `regionScope(region, { group })` call orphans the deployed group stack, same as removing a `regionScope()` call (see the caveats below).

## Migrating existing differently-named stacks

If you already run this workload as separate hand-split stacks with **different names per region** — e.g. `App-Tokyo` in `ap-northeast-1` and `App-Virginia` in `us-east-1` — the default shared-name behavior would create brand-new stacks and orphan the deployed ones. To adopt `MultiRegionStack` **in place**, name each stack to match what is already deployed:

- Set the main stack's name with the normal `stackName` prop.
- Set each twin's name with `regionScope(region, { stackName })`.

```ts
const stack = new MultiRegionStack(app, 'MyApp', {
  env: { account: '123456789012', region: 'ap-northeast-1' },
  stackName: 'App-Tokyo', // matches the existing main-region stack
});

// Matches the existing us-east-1 stack instead of the shared 'App-Tokyo' name
const cert = new acm.Certificate(
  stack.regionScope('us-east-1', { stackName: 'App-Virginia' }),
  'Cert',
  { domainName: 'example.com', validation: acm.CertificateValidation.fromDns(hostedZone) },
);

new cloudfront.Distribution(stack, 'Dist', { defaultBehavior: { origin }, certificate: cert });
```

Because CloudFormation identifies a stack by `(name, region, account)`, matching the names lets `cdk deploy` update the existing stacks rather than replace them. Notes:

- The name is used **verbatim** — for a `group`, the `-<group>` suffix is NOT appended, so pass the full name you want.
- The shared name is only a convention, so overriding works under every reference strength, `weak` included: the main stack embeds `Fn::GetStackOutput` with the twin's overridden name.
- The name follows the same rules as a group (starts with a letter; letters, digits and hyphens; ≤ 128 chars). Two stacks with the same name in the same region are rejected, and you cannot rename the main stack through its own region — use the `stackName` prop for that.
- **Still run `cdk diff` per stack before deploying** and confirm it shows updates, not replacements, especially for the main-region resources whose stack you renamed.

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
- **Destroy with a wildcard.** CLI patterns match artifact IDs, and destroy does not follow upstream dependencies: use `cdk destroy 'MyApp*'` to remove the twins too. (`cdk deploy MyApp` needs no wildcard — unless you use [groups](#resources-that-reference-the-main-stack-groups) that reference the main stack, which are downstream and need `cdk deploy 'MyApp*'` as well.)
- **Don't remove `regionScope()` calls while deployed.** Each twin keeps a no-op placeholder resource, so removing the *resources* in a region just empties the twin on next deploy. But if you remove the `regionScope()` call itself, the deployed twin stack is orphaned (CDK never deletes removed stacks) — destroy it first.
- **Dependency cycles across regions fail at synth.** A chain like A(us-east-1) → B(main) → C(us-east-1) is a stack-level cycle even though the resources form no cycle, because both reference directions land in the same pair of stacks. Put the resources that reference the main stack in a [group](#resources-that-reference-the-main-stack-groups) — the `would create a cyclic reference` error message guides you to the fix.
- **Region moves are replacements.** Moving a construct between region scopes moves it to a different stack: the resource is destroyed and recreated.

### Replacing a cross-region-referenced resource does not auto-propagate

This is the sharpest edge, and it is a limitation of CDK's cross-region reference machinery itself (you hit the same thing hand-splitting stacks with `crossRegionReferences`), not something this library adds. When a resource in one region is **replaced but keeps its logical ID** (a property change that forces replacement — new physical name / ARN), the consuming region does **not** automatically pick up the new value in any reference mode, verified end-to-end:

- **strong** (default): the cross-region export writer skips value-only updates (same key, new value), so the SSM export parameter keeps the old ARN and the consumer keeps referencing the deleted resource. This is a bug and is **fixable upstream** — a one-line writer fix restores propagation, because the reader's `{{resolve:ssm:...}}` dynamic reference re-resolves and forces a consumer changeset (verified by manually correcting the parameter). See [issue #1](https://github.com/go-to-k/cdk-multi-region-stack/issues/1).
- **weak**: the twin's `Output` correctly updates to the new ARN, but the consumer template embeds `Fn::GetStackOutput` literally and is byte-identical across the replacement, so CloudFormation does a **no-op** on the consumer (`SampleStack (no changes)`) and never re-resolves it. This is inherent to the weak mechanism, not a simple bug — weak is **worse** here than strong-once-fixed.

Workarounds if you must replace a referenced resource: rename the construct (new logical ID → the reference expression changes → propagates), or force a consumer-side change, or split into two deployments. In the flagship use case (ACM cert / WAF for CloudFront) these replacements are rare, and cert/WebACL usually can't be silently deleted while attached, so the failure tends to surface loudly rather than silently.

### The strong-reference deletion guarantee is not enforced (as of aws-cdk-lib 2.261.0)

- The documented strong-reference guarantee "the producing stack cannot be deleted while consumers exist" is currently **not enforced** (the in-use validation was removed in aws-cdk#38059). Deleting a twin alone succeeds and deletes the export parameters, breaking the consumer's next deploy. Use `cdk destroy 'MyApp*'` (destroy everything together) rather than destroying individual twins. See [issue #2](https://github.com/go-to-k/cdk-multi-region-stack/issues/2).

See [docs/FINDINGS.md](./docs/FINDINGS.md) for the full verification log behind these notes.
