import { Annotations, Stack, StackProps, Stage, Token } from 'aws-cdk-lib';
import { CfnWaitConditionHandle } from 'aws-cdk-lib/aws-cloudformation';
import { Construct } from 'constructs';

/**
 * Overrides for a single sibling stack (a region's default twin, or one of its
 * groups), used in `MultiRegionStackProps.regionStackOverrides`.
 */
export interface StackOverride {
  /**
   * CloudFormation stack name of this stack, instead of the derived default
   * (the main stack's name for a default twin, `<main stack name>-<group>` for
   * a group).
   *
   * @default - the derived name (the main stack's name, plus `-<group>` for a group)
   */
  readonly stackName?: string;

  /**
   * Construct ID of this sibling stack, instead of the derived default
   * (`<main stack construct id>-<region>` for a default twin, plus `-<group>`
   * for a group).
   *
   * The construct ID is part of every construct path in the stack, so any
   * identifier derived from the full path — `Names.uniqueId`, `node.addr`, and
   * the physical names generated for `PhysicalName.GENERATE_IF_NEEDED`
   * (which CDK applies to cross-region-referenced resources) — changes when the
   * construct ID changes, forcing those resources to be REPLACED. When adopting
   * `MultiRegionStack` for an already-deployed stack, set this to that stack's
   * existing construct ID (and keep the surrounding construct tree identical)
   * so the paths, and therefore those names, stay stable.
   *
   * @default - the derived id (`<main stack construct id>-<region>`, plus `-<group>` for a group)
   */
  readonly constructId?: string;
}

/**
 * Overrides for the sibling stacks in a single region, used in
 * `MultiRegionStackProps.regionStackOverrides`. The region's default twin and its
 * groups are configured separately so `stackName` and `constructId` stay
 * together for each stack.
 */
export interface RegionStackOverrides {
  /**
   * Overrides for the region's default twin (the stack returned by
   * `regionScope(region)` without a group).
   *
   * @default - the twin derives its name/id from the main stack
   */
  readonly defaultStack?: StackOverride;

  /**
   * Overrides for the region's groups, keyed by group name (the group returned
   * by `regionScope(region, { group })`).
   *
   * @default - each group derives its name/id from the main stack
   */
  readonly groupStacks?: { [group: string]: StackOverride };
}

/**
 * Properties for MultiRegionStack.
 *
 * Unlike a plain Stack, `env.region` is required to be a concrete value,
 * because twin stacks for other regions cannot be created for a
 * region-agnostic stack. The account may remain environment-agnostic.
 */
export interface MultiRegionStackProps extends StackProps {
  /**
   * Overrides the CloudFormation stack name and/or construct ID of the
   * twins/groups, instead of the defaults derived from the main stack — the
   * main stack's name (`<stackName>`) and `<mainId>-<region>` for a region's
   * twin, plus `-<group>` for a group. Keyed by region — the same string you
   * pass to `regionScope(region)` — with the region's default twin
   * (`defaultStack`) and its groups (`groupStacks`) configured separately.
   *
   * Declaring the overrides here — rather than at each `regionScope()` call —
   * keeps `regionScope()` a pure, order-independent accessor: the same call
   * always resolves to the same stack no matter where or how often it is
   * invoked.
   *
   * The main use case is adopting `MultiRegionStack` for a workload already
   * deployed as separate hand-split stacks (e.g. `App-Tokyo` in the main
   * region, `App-Virginia` in us-east-1). Two things must match the existing
   * deployment for an in-place update rather than a replacement:
   * - `stackName` — CloudFormation identifies a stack by `(name, region,
   *   account)`, so a matching name updates the existing stack instead of
   *   creating a new one and orphaning the old one.
   * - `constructId` — the twin's construct ID (default `<mainId>-<region>`)
   *   feeds every construct path in the stack, so it changes any full-path
   *   derived identifier (`Names.uniqueId`, `node.addr`,
   *   `PhysicalName.GENERATE_IF_NEEDED` names). Match the existing stack's
   *   construct ID to keep those stable and avoid replacing those resources.
   *   `stackName` alone does NOT prevent this — the generated names embed the
   *   construct path, not just the stack name.
   *
   * ```ts
   * new MultiRegionStack(app, 'MyApp', {
   *   env: { region: 'ap-northeast-1' },
   *   stackName: 'App-Tokyo',
   *   regionStackOverrides: {
   *     'us-east-1': {
   *       defaultStack: { stackName: 'App-Virginia', constructId: 'App-Virginia' },
   *       groupStacks: {
   *         Alarms: { stackName: 'App-Virginia-Alarms', constructId: 'App-Virginia-Alarms' },
   *       },
   *     },
   *   },
   * });
   * ```
   *
   * Sharing the main stack's name is a convention, not a technical
   * requirement: cross-region references work with any concrete name under every
   * reference strength (`strong`/`weak`/`both`). For weak, the main stack
   * embeds `Fn::GetStackOutput` with the twin's actual (overridden) name.
   *
   * Each `stackName` must start with a letter and contain only letters, digits
   * and hyphens, and stay within 128 characters; each `constructId` must be a
   * non-empty string without `/`. Two stacks with the same name in the same
   * region — or two constructs with the same ID — are rejected. A `stackName`
   * or `constructId` for the stack's own region is rejected — set the main
   * stack's name via the top-level `stackName` prop and its construct ID via
   * the `id` argument — though groups in the own region may still be
   * overridden here.
   *
   * @default - every twin/group derives its name and construct ID from the main stack
   */
  readonly regionStackOverrides?: { [region: string]: RegionStackOverrides };
}

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

const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const MAX_STACK_NAME_LENGTH = 128;
const WARNING_ID = 'cdk-multi-region-stack:stackNotDeployedWithMainStack';
const UNUSED_NAME_WARNING_ID = 'cdk-multi-region-stack:unusedRegionStackName';
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
 * Whether an override actually declares something (a name or a construct ID),
 * so an empty `{}` does not count as a used entry for the unused-entry warning.
 */
function isDeclared(override: StackOverride | undefined): boolean {
  return (
    override !== undefined &&
    (override.stackName !== undefined || override.constructId !== undefined)
  );
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
 * stack: a sibling Stack with the same stack name as the main stack, deployed
 * to the given region. Constructs created in that scope are provisioned in that region,
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
  private readonly warnedUnusedNameKeys = new Set<string>();
  private readonly inheritedProps: MultiRegionStackProps;
  private readonly regionStackOverrides: { [region: string]: RegionStackOverrides };

  constructor(scope: Construct, id: string, props: MultiRegionStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });
    this.inheritedProps = props;
    this.regionStackOverrides = props.regionStackOverrides ?? {};

    if (Token.isUnresolved(this.region)) {
      throw new Error(
        'MultiRegionStack requires a concrete `env.region`: specify it in props (the account may remain environment-agnostic)',
      );
    }

    this.validateRegionStackOverrides();

    // Runs after prepareApp (which resolves cross-stack references into
    // stack dependencies), so the dependency graph is final here.
    this.node.addValidation({
      validate: () => {
        this.warnAboutStacksNotDeployedWithMain();
        this.warnAboutUnusedRegionStackOverrides();
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
   * A twin's stack name and construct ID come from the `regionStackOverrides` prop
   * (keyed by region, then `defaultStack`/`groupStacks`); a region or group
   * with no entry falls back to the defaults (the main stack's name and
   * `<mainId>-<region>`, each plus `-<group>` for a group). Because these are
   * declared on the stack, not passed here, `regionScope()` stays a pure
   * accessor: the same call always resolves to the same stack regardless of
   * call order.
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
    if (twin) {
      return twin;
    }

    if (group !== undefined) {
      this.validateGroupName(group);
    }
    const suffix = group === undefined ? '' : `-${group}`;
    const regionCfg = this.regionStackOverrides[region];
    const override =
      group === undefined ? regionCfg?.defaultStack : regionCfg?.groupStacks?.[group];
    const stackName = override?.stackName ?? `${this.stackName}${suffix}`;
    const constructId = override?.constructId ?? `${this.node.id}-${region}${suffix}`;
    this.validateStackNameLength(stackName);
    this.validateNoStackNameCollision(region, stackName);
    this.validateNoConstructIdCollision(constructId);

    const parent = Stage.of(this) ?? this.node.root;
    twin = new TwinStack(parent as Construct, constructId, {
      stackName,
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

  /**
   * A `regionStackOverrides` entry only takes effect when the matching twin is
   * created (`regionScope()` is called for it). An entry with no matching
   * twin is either a typo in the region/group or a region intentionally
   * skipped in this environment — warn so a silently-ineffective override
   * (which would defeat an in-place migration) does not go unnoticed. The Set
   * guard keeps the warning from being appended again on repeated synth.
   */
  private warnAboutUnusedRegionStackOverrides(): void {
    for (const [region, cfg] of Object.entries(this.regionStackOverrides)) {
      if (isDeclared(cfg.defaultStack) && !this.twins.has(region)) {
        this.warnUnusedOverride(region, `regionStackOverrides['${region}'].defaultStack`, region);
      }
      for (const [group, override] of Object.entries(cfg.groupStacks ?? {})) {
        const key = `${region}/${group}`;
        if (isDeclared(override) && !this.twins.has(key)) {
          this.warnUnusedOverride(
            key,
            `regionStackOverrides['${region}'].groupStacks['${group}']`,
            region,
            group,
          );
        }
      }
    }
  }

  private warnUnusedOverride(key: string, label: string, region: string, group?: string): void {
    if (this.warnedUnusedNameKeys.has(key)) {
      return;
    }
    this.warnedUnusedNameKeys.add(key);
    const call =
      group === undefined
        ? `regionScope('${region}')`
        : `regionScope('${region}', { group: '${group}' })`;
    Annotations.of(this).addWarningV2(
      UNUSED_NAME_WARNING_ID,
      `${label} is declared but unused: ${call} is never called, so this override has no effect. ` +
        'Remove it, or fix a typo in the region/group. ' +
        '(If the region is intentionally skipped in this environment, acknowledge this warning.)',
    );
  }

  private validateGroupName(group: string): void {
    if (!STACK_NAME_PATTERN.test(group)) {
      throw new Error(
        `regionScope() group must start with a letter and contain only letters, digits and hyphens (it becomes part of the stack name), got: '${group}'`,
      );
    }
  }

  /**
   * Validates the `regionStackOverrides` overrides up front (independent of which
   * regions are actually used): each stackName's format and length, each
   * constructId's format, each group key's format, and that the stack's own
   * region does not override the default twin (which would collide with the
   * main stack itself; its groups may still be overridden).
   */
  private validateRegionStackOverrides(): void {
    for (const [region, cfg] of Object.entries(this.regionStackOverrides)) {
      if (cfg.defaultStack !== undefined) {
        this.validateOverride(`regionStackOverrides['${region}'].defaultStack`, cfg.defaultStack, {
          isOwnRegionDefault: region === this.region,
        });
      }
      for (const [group, override] of Object.entries(cfg.groupStacks ?? {})) {
        this.validateGroupName(group);
        this.validateOverride(
          `regionStackOverrides['${region}'].groupStacks['${group}']`,
          override,
          {
            isOwnRegionDefault: false,
          },
        );
      }
    }
  }

  /**
   * Validates a single `stackName`/`constructId` override. The default twin of
   * the stack's own region is rejected: it would refer to the main stack,
   * whose name comes from the `stackName` prop and whose construct ID comes
   * from the `id` argument. Groups (in any region) are always allowed.
   */
  private validateOverride(
    label: string,
    override: StackOverride,
    opts: { isOwnRegionDefault: boolean },
  ): void {
    if (opts.isOwnRegionDefault && override.stackName !== undefined) {
      throw new Error(
        `${label}.stackName cannot rename the main stack (its own region); set its name via the \`stackName\` prop instead`,
      );
    }
    if (opts.isOwnRegionDefault && override.constructId !== undefined) {
      throw new Error(
        `${label}.constructId cannot change the main stack's construct ID (its own region); set it via the \`id\` argument instead`,
      );
    }
    if (override.stackName !== undefined) {
      this.validateOverrideName(`${label}.stackName`, override.stackName);
    }
    if (override.constructId !== undefined) {
      this.validateConstructId(`${label}.constructId`, override.constructId);
    }
  }

  private validateOverrideName(label: string, name: string): void {
    if (!STACK_NAME_PATTERN.test(name)) {
      throw new Error(
        `${label} must start with a letter and contain only letters, digits and hyphens, got: '${name}'`,
      );
    }
    this.validateStackNameLength(name);
  }

  private validateConstructId(label: string, constructId: string): void {
    if (constructId.length === 0 || constructId.includes('/')) {
      throw new Error(
        `${label} must be a non-empty string without '/' (it is a construct ID), got: '${constructId}'`,
      );
    }
  }

  private validateStackNameLength(stackName: string): void {
    if (!Token.isUnresolved(stackName) && stackName.length > MAX_STACK_NAME_LENGTH) {
      throw new Error(`stack name '${stackName}' would exceed ${MAX_STACK_NAME_LENGTH} characters`);
    }
  }

  /**
   * Two stacks with the same name in the same region collide at deploy time.
   * The main stack occupies its own name in its region; each existing
   * twin/group occupies its resolved name in its region.
   */
  private validateNoStackNameCollision(region: string, stackName: string): void {
    const mainCollides = region === this.region && stackName === this.stackName;
    const twinCollides = [...this.twins.values()].some(
      (t) => t.region === region && t.stackName === stackName,
    );
    if (mainCollides || twinCollides) {
      throw new Error(
        `regionScope() would create a second stack named '${stackName}' in region '${region}'; stack names must be unique per region`,
      );
    }
  }

  /**
   * Twins/groups are siblings of the main stack (all under the same enclosing
   * Stage or App), so their construct IDs share one namespace with the main
   * stack. CDK would reject a duplicate ID with an opaque error; check up front
   * for a message that names the override to fix. Unlike stack names, construct
   * IDs must be unique across regions too (they live under one parent).
   */
  private validateNoConstructIdCollision(constructId: string): void {
    const mainCollides = constructId === this.node.id;
    const twinCollides = [...this.twins.values()].some((t) => t.node.id === constructId);
    if (mainCollides || twinCollides) {
      throw new Error(
        `regionScope() would create a second construct with id '${constructId}'; construct ids must be unique among the main stack and its twins/groups`,
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
