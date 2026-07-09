# cdk-multi-region-stack

A CDK `Stack` that can place some of its resources in **other regions**, while everything stays in **one logical stack** in your CDK app.

Typical use case: your application lives in `ap-northeast-1`, but the ACM certificate and WAF WebACL for your CloudFront distribution must live in `us-east-1`. Today you split them into separate stacks by hand. With `MultiRegionStack` you write them as one stack:

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

At synth time this produces one CloudFormation stack per region, all with the **same stack name**. References that cross regions are wired through CDK's built-in cross-region reference machinery (`crossRegionReferences: true` is enabled automatically).

## How it works

- `stack.regionScope(region)` lazily creates a "twin" `Stack` — a sibling of your stack (under the same `App`/`Stage`) with the same `stackName`, targeting the same account in the given region. Constructs created in that scope deploy to that region.
- Because the main stack references twin values, the CDK CLI treats twins as upstream dependencies: **`cdk deploy MyApp` deploys the twins automatically**, twins first.
- Values crossing regions use CDK's export machinery. The reference strength (`strong` / `weak` / `both`) follows the `@aws-cdk/core:defaultCrossStackReferences` context flag (aws-cdk-lib >= 2.254.0). See [reference strength](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/README.md#reference-strength).

## Requirements and caveats

- **Concrete `env` required.** `env.account` and `env.region` must be specified; environment-agnostic stacks are rejected.
- **Destroy with a wildcard.** CLI patterns match artifact IDs, and destroy does not follow upstream dependencies: use `cdk destroy 'MyApp*'` to remove the twins too. (`cdk deploy MyApp` needs no wildcard.)
- **Don't remove `regionScope()` calls while deployed.** Each twin keeps a no-op placeholder resource, so removing the *resources* in a region just empties the twin on next deploy. But if you remove the `regionScope()` call itself, the deployed twin stack is orphaned (CDK never deletes removed stacks) — destroy it first.
- **Dependency cycles across regions fail at synth.** A chain like A(us-east-1) → B(main) → C(us-east-1) is a stack-level cycle even though the resources form no cycle. Restructure (move a resource, or split a real second stack) if you hit `would create a cyclic reference`.
- **Region moves are replacements.** Moving a construct between region scopes moves it to a different stack: the resource is destroyed and recreated.

### Upstream issues you should know about (as of aws-cdk-lib 2.261.0)

- With **strong** references, replacing a producer resource (same logical ID, new ARN) does **not** propagate the new value: the cross-region export writer skips value-only updates, so consumers keep referencing the old (deleted) resource. Weak references resolve at consumer deploy time via `Fn::GetStackOutput` and don't have the writer half of this problem, but any mode requires a consumer-side deployment to pick up new values.
- The documented strong-reference guarantee "the producing stack cannot be deleted while consumers exist" is currently **not enforced** (the in-use validation was removed in aws-cdk#38059).

See [docs/FINDINGS.md](./docs/FINDINGS.md) for the full verification log behind these notes.
