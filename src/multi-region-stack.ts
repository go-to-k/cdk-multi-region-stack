import { Stack, StackProps, Stage, Token } from 'aws-cdk-lib';
import { CfnWaitConditionHandle } from 'aws-cdk-lib/aws-cloudformation';
import { Construct } from 'constructs';

/**
 * Properties for MultiRegionStack.
 *
 * Unlike a plain Stack, `env.account` and `env.region` are required to be
 * concrete values, because twin stacks for other regions cannot be created
 * for an environment-agnostic stack.
 */
export interface MultiRegionStackProps extends StackProps {}

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
 * new cloudfront.Distribution(stack, 'Dist', { certificates: [cert], ... });
 * ```
 *
 * Deploying/destroying by stack name (`cdk deploy MyApp`) selects the twin
 * stacks as well, because CLI patterns also match on stack names.
 */
export class MultiRegionStack extends Stack {
  private readonly twins = new Map<string, Stack>();
  private readonly inheritedProps: MultiRegionStackProps;

  constructor(scope: Construct, id: string, props: MultiRegionStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });
    this.inheritedProps = props;

    if (Token.isUnresolved(this.account) || Token.isUnresolved(this.region)) {
      throw new Error(
        'MultiRegionStack requires a concrete env: specify both `env.account` and `env.region` in props',
      );
    }
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
   * @param region The region in which constructs created in this scope will be provisioned (e.g. `us-east-1`)
   */
  public regionScope(region: string): Stack {
    if (Token.isUnresolved(region)) {
      throw new Error('regionScope() requires a concrete region string, got an unresolved token');
    }
    if (region === this.region) {
      return this;
    }

    let twin = this.twins.get(region);
    if (!twin) {
      const parent = Stage.of(this) ?? this.node.root;
      twin = new Stack(parent as Construct, `${this.node.id}-${region}`, {
        stackName: this.stackName,
        env: { account: this.account, region },
        crossRegionReferences: true,
        description: this.inheritedProps.description,
        terminationProtection: this.inheritedProps.terminationProtection,
        tags: this.inheritedProps.tags,
      });
      // CloudFormation rejects templates with zero resources. Keeping a
      // no-op placeholder means "user removed the last resource in this
      // region" results in an (almost) empty twin stack being updated,
      // instead of the deployed resources being silently orphaned.
      new CfnWaitConditionHandle(twin, 'Placeholder');
      this.twins.set(region, twin);
    }
    return twin;
  }
}
