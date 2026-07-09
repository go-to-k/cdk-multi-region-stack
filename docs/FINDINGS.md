# MultiRegionStack — Design decisions and verification log

Verified: 2026-07-09 / Targets: aws-cdk-lib 2.261.0 (live deploy), 2.254.0 (unit tests)

## Design (settled)

- `MultiRegionStack extends Stack`. `regionScope(region)` lazily creates and returns a twin
  Stack with the **same stackName in a different region**, parented under `Stage.of(this) ?? App`.
- Region is selectable only by the scope you pass in (a construct cannot be re-parented after
  construction, and a `Resource` bakes in `Stack.of` / env in its constructor, so moving it
  afterwards is impossible).
- Cross-region references are fully delegated to core's `crossRegionReferences: true`.
  strong / weak / both follow `@aws-cdk/core:defaultCrossStackReferences` (2.254.0+, a
  consumer-side context flag).
- Cycles (A(use1)→B(main)→C(use1)) are a synth error. Resolving them via concurrent deploy +
  a generation-stamped wait reader (`resolutionMode: 'concurrent'`) is **deferred to v2** (it is
  an explicit API, so it can be added backward-compatibly; the implementation is 5–10× the size
  of the core: a Provider-framework isComplete wait reader + generation stamps + operational docs).
- The twin always includes a placeholder (`AWS::CloudFormation::WaitConditionHandle`) to mitigate
  orphaning — "delete the last resource and you get an empty, undeployable template".

## Phase 1: synth verification — all as expected

| Item | Result |
| --- | --- |
| Two artifacts with the same stackName | synth OK. Stack dependencies are also auto-generated from references |
| strong reference | ExportWriter on the twin, ExportReader on main (each +Lambda/Role, 3 resources per side). The Reader's property is a `{{resolve:ssm:...}}` dynamic reference, so a parameter value change is detected on the consumer deploy by design |
| weak reference | Zero extra infrastructure. `Fn::GetStackOutput {StackName: same name, Region: us-east-1}` — consistent with the same-stackName design |
| both reference | Producer: keeps the Writer + adds an Output; consumer: switches to GetStackOutput. Matches the migration procedure |
| Cycle detection | Native error at synth time (`would create a cyclic reference`, with resource path) |
| Empty twin | A zero-resource template → confirms the placeholder is required |

## Phase 2: live deploy verification (2026-07-09, account cleaned up afterwards)

| Item | Result |
| --- | --- |
| One-shot `cdk deploy SampleStack` | ✅ `Including dependency stacks:` auto-includes the twin, twin first |
| Value match | ✅ consumer == twin Topic ARN. `/cdk/exports/SampleStack/...` parameter created |
| Replacement propagation | ❌ **Upstream bug found** (below) |
| Fix simulation | ✅ Manually correcting the SSM value makes the consumer detect and follow via the dynamic reference (the design is sound; the bug is in the Writer only) |
| strong deletion guard | ❌ **Confirmed gone** (below). Destroying the twin alone succeeds and deletes the parameter |
| strong→both→weak migration | ✅ Completed in 3 deploys. `Fn::GetStackOutput` works in a real environment. After going weak the custom resource disappears and the value is retained |
| destroy | ⚠️ `cdk destroy SampleStack` targets main only (see CLI selection below). `'SampleStack*'` deletes both ✅ |

### Exact CLI stack-selection behavior

- The pattern matches **artifact ids only** (not stackName)
- `cdk ls` / `cdk deploy` **auto-include upstream dependencies**, so the twin is pulled in (the
  artifact dependency is preserved even in weak mode)
- `cdk destroy` goes downstream, so the twin is not pulled in → **destroy requires `'MyApp*'`**
  (documented in the README)

## Upstream (aws-cdk) issues found

1 and 2 are filed ([#1](https://github.com/go-to-k/cdk-multi-region-stack/issues/1) /
[#2](https://github.com/go-to-k/cdk-multi-region-stack/issues/2)). 3 is an inherent, unfixable
limitation of the mechanism, so it has no dedicated issue and is documented as a known limitation
in the README.

### 1. The Writer silently drops "same-key value changes" (replacement doesn't propagate) ([#1](https://github.com/go-to-k/cdk-multi-region-stack/issues/1))

The `cross-region-ssm-writer-handler` Update path uses `except()` (a key-only diff) and only
handles additions/removals, so **a resource replacement that keeps its logical ID (same name,
value changed) is never put**. The consumer keeps referencing the deleted resource's ARN.

- 2.254.0 (before #38059): detected value changes and threw `Some exports have changed!`
  ("noisy but safe" strong semantics, equivalent to ImportValue)
- After #38059 (confirmed on 2.261.0): removing the validation also removed the throw, regressing
  to a **silent inconsistency**
- Proposed fix: `putParameter` all exports in Update (already `Overwrite: true`). Because the
  Reader picks up changes via a dynamic reference by design, this alone makes replacement
  propagate correctly (verified on a real deploy).

### 2. The strong deletion guard is not enforced (contradicts the docs) ([#2](https://github.com/go-to-k/cdk-multi-region-stack/issues/2))

The `@aws-cdk/core:defaultCrossStackReferences` flag docs state "strong prevents the producing
stack from being deleted while consumers exist", but #38059 removed the in-use validation
entirely, so **destroying the producer while the consumer is still alive succeeds and the export
parameter is deleted** (confirmed on a real deploy). Subsequent consumer deploys should then fail
to resolve `{{resolve:ssm}}`.

### 3. weak-mode replacement non-propagation (not a bug, an inherent limitation of the mechanism) — re-verified 2026-07-09

The initial guess was "if there's a replacement, going weak makes it follow", but this was
**disproven on a real deploy**. In weak mode, replacing the twin's Topic (topicName changed,
logical ID kept) and redeploying resulted in:

- The twin's `Output PublishOutputRefGlobalTopic...` **correctly updated to the new ARN
  (mrs-global-v2)**
- But the consumer became **`SampleStack (no changes)` (a full 0-second no-op deploy)** and kept
  the old ARN
- Cause: the consumer template embeds `Fn::GetStackOutput{StackName, Region, OutputName}`
  **literally**, and OutputName derives from the logical ID and is unchanged across the
  replacement → the template is byte-identical → CFn creates no changeset, so GetStackOutput is
  never re-resolved

The **strong/weak asymmetry** became clear:

- strong: the consumer's Reader property is a `{{resolve:ssm}}` dynamic reference. When the SSM
  value changes a changeset diff appears and the Reader re-runs. **So fixing just the Writer makes
  it propagate** (solvable by fixing bug #1).
- weak: `Fn::GetStackOutput` does not have the "value change → changeset diff" property of a
  dynamic reference, so a same-logical-ID replacement leaves the consumer a no-op. **An inherent
  limitation of the mechanism that a simple fix cannot address.**

Conclusion: replacement propagation is broken in the current release for both strong and weak, but
**strong is fixable upstream while weak is not**. The initial "recommend weak for replacements" was
wrong. Workarounds: change the logical ID (rename the construct) / force a consumer-side change /
deploy twice. Reflected in the README.

## Reproducing the verification

The Phase 1/2 verification has been distilled into integ tests. To reproduce or run a regression
check, see `test/integ.multi-region-stack.ts` / `-stage.ts` / `-weak.ts` (`pnpm integ:update`).

## Notes (updated 2026-07-09)

- The env requirement is relaxed to "region only" (account may be agnostic — same shape as the
  upstream integ.cross-region-references.ts; no account ID ends up in the integ snapshot)
- integ tests implemented and live-deployed, 1/1 pass (`pnpm integ:update`, ~200s, auto-cleaned
  after the test)
- Ran an additional weak-mode replacement verification → found upstream issue #3 (an inherent
  limitation). Account fully cleaned up afterwards.

## Open items

- Aspects / Tags propagation to the twin (currently only the description / terminationProtection /
  tags props are inherited; `Tags.of(stack)` does not reach the twin — document or implement)
- Catching and re-wrapping the cycle error is impossible (it happens inside app.synth()) →
  documented in the README
- The 2 upstream issues are filed ([#1](https://github.com/go-to-k/cdk-multi-region-stack/issues/1) /
  [#2](https://github.com/go-to-k/cdk-multi-region-stack/issues/2)). The Writer could also be a
  one-line fix PR
- v2: `resolutionMode: 'concurrent'`
