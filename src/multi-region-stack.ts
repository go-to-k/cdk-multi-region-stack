import { Annotations, Stack, StackProps, Stage, Token } from 'aws-cdk-lib';
import { CfnWaitConditionHandle } from 'aws-cdk-lib/aws-cloudformation';
import { Construct } from 'constructs';

/**
 * Properties for MultiRegionStack.
 *
 * Unlike a plain Stack, `env.region` is required to be a concrete value,
 * because twin stacks for other regions cannot be created for a
 * region-agnostic stack. The account may remain environment-agnostic.
 */
export interface MultiRegionStackProps extends StackProps {}

/**
 * Options for `MultiRegionStack.regionScope()`.
 */
export interface RegionScopeOptions {
  /**
   * Name of an additional stack ("group") in the region.
   *
   * By default a region has a single stack (the "twin", sharing the main
   * stack's name). Some resources cannot live in that stack: a CloudWatch
   * alarm on CloudFront metrics must be in us-east-1 AND references the
   * distribution in the main stack, while the main stack already references
   * the ACM certificate in us-east-1 — putting both directions in one stack
   * is a cyclic reference. A group is a separate stack in the same region
   * that breaks the cycle; the deploy order is derived automatically from
   * the references. If the region holds nothing the main stack references
   * (e.g. an alarm with no ACM certificate there), the reference is
   * one-directional and the resource can go straight into the default
   * `regionScope(region)` — no group needed.
   *
   * The group name becomes part of the stack name
   * (`<stackName>-<group>`), so it must start with a letter and contain
   * only letters, digits and hyphens. The same `(region, group)` pair
   * always returns the same stack. Groups in the stack's own region are
   * allowed and create a sibling stack in the main region.
   *
   * Note: a stack that is not a dependency of the main stack (e.g. a group
   * whose resources reference the main stack) is NOT deployed by
   * `cdk deploy <MainStack>` — deploy with a wildcard. A warning is
   * emitted at synth time for such stacks.
   *
   * @default - the region's default twin stack (or the stack itself for its own region)
   */
  readonly group?: string;
}

const GROUP_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const MAX_STACK_NAME_LENGTH = 128;
const WARNING_ID = 'cdk-multi-region-stack:stackNotDeployedWithMainStack';
const CYCLIC_REFERENCE_ISSUE_URL = 'https://github.com/go-to-k/cdk-multi-region-stack/issues/6';

/**
 * Maps twin/group stacks to the MultiRegionStack that created them, so the
 * addDependency overrides can tell family cycles apart from cycles with
 * unrelated user stacks.
 */
const OWNERS = new WeakMap<Stack, MultiRegionStack>();

function familyOf(stack: Stack): MultiRegionStack | undefined {
  return stack instanceof MultiRegionStack ? stack : OWNERS.get(stack);
}

/**
 * CDK's cyclic-reference ValidationError names the stacks but not the fix.
 * When the cycle is within one MultiRegionStack family (the main stack plus
 * its twins and groups), append the cause and the fix. The message is
 * mutated on the SAME error instead of wrapping it in a new one, preserving
 * the ValidationError type that the CLI and user tooling key on.
 */
function enrichCyclicReferenceError(e: unknown, consumer: Stack, target: Stack): unknown {
  if (
    !(e instanceof Error) ||
    !/cyclic reference/.test(e.message) ||
    e.message.includes(CYCLIC_REFERENCE_ISSUE_URL)
  ) {
    return e;
  }
  const owner = familyOf(consumer);
  if (owner === undefined || familyOf(target) !== owner) {
    return e;
  }
  const twin = consumer === owner ? target : consumer;
  e.message =
    `${e.message}\n\n` +
    'Cross-stack references between these stacks go in both directions (e.g. the main stack ' +
    'references an ACM certificate in the region while a CloudWatch alarm in the region ' +
    'references the main stack). A single stack pair cannot hold both directions.\n' +
    'Move the constructs that reference the main stack into a separate group ' +
    '(any group name not yet used in that region):\n' +
    `  stack.regionScope('${twin.region}', { group: 'Alarms' })\n` +
    `See ${CYCLIC_REFERENCE_ISSUE_URL}`;
  return e;
}

/**
 * A Stack that can place some of its resources in other regions.
 *
 * Calling `regionScope(region)` returns a scope that belongs to a "twin"
 * stack: a sibling Stack with the SAME stack name deployed to the given
 * region. Constructs created in that scope are provisioned in that region,
 * while references between the twin and the main stack are wired through
 * CDK's built-in cross-region reference machinery (`crossRegionReferences`).
 *
 * Typical use case: a CloudFront distribution in your main region whose
 * ACM certificate and WAF WebACL must live in us-east-1.
 *
 * ```ts
 * const stack = new MultiRegionStack(app, 'MyApp', {
 *   env: { account: '123456789012', region: 'ap-northeast-1' },
 * });
 * const cert = new acm.Certificate(stack.regionScope('us-east-1'), 'Cert', { ... });
 * new cloudfront.Distribution(stack, 'Dist', { certificate: cert, ... });
 * ```
 *
 * A resource that must live in another region and reference the main stack
 * only needs special handling when it shares that region with a resource the
 * main stack references — e.g. a CloudWatch alarm on CloudFront metrics
 * alongside the ACM certificate in us-east-1. Putting both in one stack makes
 * the two stacks reference each other, a cyclic reference. Put the
 * main-referencing resource in a "group" — an additional stack in that
 * region — to break the cycle (an alarm with no such twin in its region can
 * go straight into the default twin instead):
 *
 * ```ts
 * new cw.Alarm(stack.regionScope('us-east-1', { group: 'Alarms' }), 'Errors', { ... });
 * ```
 *
 * `cdk deploy MyApp` deploys the twin stacks as well (they are upstream
 * dependencies of the main stack). Stacks that are NOT dependencies of the
 * main stack (such as groups referencing the main stack) are not included:
 * use a wildcard, `cdk deploy 'MyApp*'`. Destroying does not follow
 * dependencies either, so use a wildcard: `cdk destroy 'MyApp*'`.
 */
export class MultiRegionStack extends Stack {
  private readonly twins = new Map<string, Stack>();
  private readonly warnedStacks = new Set<Stack>();
  private readonly inheritedProps: MultiRegionStackProps;

  constructor(scope: Construct, id: string, props: MultiRegionStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });
    this.inheritedProps = props;

    if (Token.isUnresolved(this.region)) {
      throw new Error(
        'MultiRegionStack requires a concrete `env.region`: specify it in props (the account may remain environment-agnostic)',
      );
    }

    // Runs after prepareApp (which resolves cross-stack references into
    // stack dependencies), so the dependency graph is final here.
    this.node.addValidation({
      validate: () => {
        this.warnAboutStacksNotDeployedWithMain();
        return [];
      },
    });
  }

  /**
   * Returns a scope belonging to the twin stack for the given region.
   *
   * The twin stack is created lazily on first call for a region:
   * - it is a sibling of this stack (child of the enclosing Stage or App)
   * - it has the same stack name as this stack
   * - it targets the same account, in the given region
   *
   * Calling this with the stack's own region returns the stack itself.
   * Calling it twice with the same region returns the same twin.
   *
   * With `options.group`, an additional stack named `<stackName>-<group>`
   * is created in the region instead of the default twin — use this when
   * placing a main-referencing resource in the default twin would create a
   * cyclic reference, i.e. that twin also holds a resource the main stack
   * references (see `RegionScopeOptions.group`). A group in the stack's own
   * region creates a sibling stack in the main region.
   *
   * @param region The region in which constructs created in this scope will be provisioned (e.g. `us-east-1`)
   * @param options Options, e.g. a `group` for an additional stack in the region
   */
  public regionScope(region: string, options?: RegionScopeOptions): Stack {
    if (Token.isUnresolved(region)) {
      throw new Error('regionScope() requires a concrete region string, got an unresolved token');
    }
    const group = options?.group;
    if (group === undefined && region === this.region) {
      return this;
    }

    const key = group === undefined ? region : `${region}/${group}`;
    let twin = this.twins.get(key);
    if (!twin) {
      if (group !== undefined) {
        this.validateGroupName(group);
      }
      const parent = Stage.of(this) ?? this.node.root;
      const suffix = group === undefined ? '' : `-${group}`;
      twin = new TwinStack(parent as Construct, `${this.node.id}-${region}${suffix}`, {
        stackName: `${this.stackName}${suffix}`,
        env: {
          account: Token.isUnresolved(this.account) ? undefined : this.account,
          region,
        },
        crossRegionReferences: true,
        description: this.inheritedProps.description,
        terminationProtection: this.inheritedProps.terminationProtection,
        tags: this.inheritedProps.tags,
      });
      OWNERS.set(twin, this);
      // CloudFormation rejects templates with zero resources. Keeping a
      // no-op placeholder means "user removed the last resource in this
      // region" results in an (almost) empty twin stack being updated,
      // instead of the deployed resources being silently orphaned.
      new CfnWaitConditionHandle(twin, 'Placeholder');
      this.twins.set(key, twin);
    }
    return twin;
  }

  public addDependency(target: Stack, reason?: string): void {
    try {
      super.addDependency(target, reason);
    } catch (e) {
      throw enrichCyclicReferenceError(e, this, target);
    }
  }

  /**
   * `cdk deploy <MainStack>` extends the selection to dependencies only.
   * Any twin/group that is not (transitively) a dependency of the main
   * stack — typically a group whose resources reference the main stack —
   * is silently skipped, so warn about it. The Set guard keeps the warning
   * from being appended again when the app is synthesized more than once.
   *
   * The message uses construct paths, not artifact IDs: CLI patterns match
   * the hierarchical ID, which is the path for Stage-nested stacks (e.g.
   * `MyStage/MyStack`) and the plain ID at the app level.
   */
  private warnAboutStacksNotDeployedWithMain(): void {
    const deployedWithMain = new Set<Stack>();
    const queue: Stack[] = [this];
    while (queue.length > 0) {
      const stack = queue.pop()!;
      if (deployedWithMain.has(stack)) {
        continue;
      }
      deployedWithMain.add(stack);
      queue.push(...stack.dependencies);
    }

    for (const twin of this.twins.values()) {
      if (!deployedWithMain.has(twin) && !this.warnedStacks.has(twin)) {
        this.warnedStacks.add(twin);
        Annotations.of(twin).addWarningV2(
          WARNING_ID,
          `'${twin.node.path}' is not a dependency of '${this.node.path}', so 'cdk deploy ${this.node.path}' will ` +
            'NOT deploy it (the CLI extends the selection to dependencies only). ' +
            `Deploy with a wildcard: cdk deploy '${this.node.path}*'`,
        );
      }
    }
  }

  private validateGroupName(group: string): void {
    if (!GROUP_NAME_PATTERN.test(group)) {
      throw new Error(
        `regionScope() group must start with a letter and contain only letters, digits and hyphens (it becomes part of the stack name), got: '${group}'`,
      );
    }
    if (
      !Token.isUnresolved(this.stackName) &&
      `${this.stackName}-${group}`.length > MAX_STACK_NAME_LENGTH
    ) {
      throw new Error(
        `regionScope() group makes the stack name '${this.stackName}-${group}' exceed ${MAX_STACK_NAME_LENGTH} characters`,
      );
    }
  }
}

/**
 * A twin/group stack. Plain Stack behavior, except that CDK's bare
 * "would create a cyclic reference" error is enriched with the cause and
 * the `group` fix when the cycle is within the family.
 */
class TwinStack extends Stack {
  public addDependency(target: Stack, reason?: string): void {
    try {
      super.addDependency(target, reason);
    } catch (e) {
      throw enrichCyclicReferenceError(e, this, target);
    }
  }
}
