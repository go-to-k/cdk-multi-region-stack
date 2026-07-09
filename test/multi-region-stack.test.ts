import { App, Aws, Stage, Token } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MultiRegionStack } from '../src';

const env = { account: '111111111111', region: 'ap-northeast-1' };

const createStacks = (app: App) => {
  const stack = new MultiRegionStack(app, 'MyStack', { env });
  const use1 = stack.regionScope('us-east-1');
  const topic = new sns.Topic(use1, 'Topic');
  new ssm.StringParameter(stack, 'Param', { stringValue: topic.topicArn });
  return { stack, use1 };
};

describe('snapshot', () => {
  test('main and twin templates (strong references)', () => {
    const { stack, use1 } = createStacks(new App());
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot('main');
    expect(Template.fromStack(use1).toJSON()).toMatchSnapshot('twin');
  });

  test('main and twin templates (weak references)', () => {
    const app = new App({
      context: { '@aws-cdk/core:defaultCrossStackReferences': 'weak' },
    });
    const { stack, use1 } = createStacks(app);
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot('main-weak');
    expect(Template.fromStack(use1).toJSON()).toMatchSnapshot('twin-weak');
  });
});

describe('twin stack creation', () => {
  test('twin is a sibling under the App with the same stack name and account, in the requested region', () => {
    const app = new App();
    const { stack, use1 } = createStacks(app);

    expect(use1.node.scope).toBe(app);
    expect(use1.stackName).toBe(stack.stackName);
    expect(use1.account).toBe(stack.account);
    expect(use1.region).toBe('us-east-1');
  });

  test('twin is created under the enclosing Stage when the stack is in a Stage', () => {
    const app = new App();
    const stage = new Stage(app, 'Prod');
    const stack = new MultiRegionStack(stage, 'MyStack', { env });
    const use1 = stack.regionScope('us-east-1');

    expect(use1.node.scope).toBe(stage);
    expect(Stage.of(use1)).toBe(stage);
  });

  test('regionScope with the stack own region returns the stack itself', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    expect(stack.regionScope('ap-northeast-1')).toBe(stack);
  });

  test('regionScope called twice with the same region returns the same twin', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    expect(stack.regionScope('us-east-1')).toBe(stack.regionScope('us-east-1'));
  });

  test('twin contains a placeholder resource so an emptied twin remains deployable', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    const use1 = stack.regionScope('us-east-1');
    Template.fromStack(use1).resourceCountIs('AWS::CloudFormation::WaitConditionHandle', 1);
  });

  test('description, terminationProtection and tags are inherited by the twin', () => {
    const app = new App();
    const stack = new MultiRegionStack(app, 'MyStack', {
      env,
      description: 'my description',
      terminationProtection: true,
      tags: { CostCenter: 'X' },
    });
    const use1 = stack.regionScope('us-east-1');

    expect(Template.fromStack(use1).toJSON().Description).toBe('my description');
    expect(use1.terminationProtection).toBe(true);
    expect(use1.tags.tagValues()).toEqual({ CostCenter: 'X' });
  });
});

describe('cross-region references', () => {
  test('strong (default): reader in main stack, writer in twin stack', () => {
    const { stack, use1 } = createStacks(new App());
    Template.fromStack(stack).resourceCountIs('Custom::CrossRegionExportReader', 1);
    Template.fromStack(use1).resourceCountIs('Custom::CrossRegionExportWriter', 1);
  });

  test('weak: no custom resources, consumer uses Fn::GetStackOutput against the same stack name', () => {
    const app = new App({
      context: { '@aws-cdk/core:defaultCrossStackReferences': 'weak' },
    });
    const { stack, use1 } = createStacks(app);

    Template.fromStack(stack).resourceCountIs('Custom::CrossRegionExportReader', 0);
    Template.fromStack(use1).resourceCountIs('Custom::CrossRegionExportWriter', 0);

    const param = Object.values(
      Template.fromStack(stack).findResources('AWS::SSM::Parameter'),
    )[0] as any;
    expect(param.Properties.Value['Fn::GetStackOutput']).toEqual(
      expect.objectContaining({ StackName: stack.stackName, Region: 'us-east-1' }),
    );
  });
});

describe('groups', () => {
  // The flagship shape: cert (twin) <- dist (main) <- alarm (group),
  // wired purely through references, without any addDependency call.
  const createGroupedStacks = (app: App) => {
    const stack = new MultiRegionStack(app, 'MyStack', { env });
    const use1 = stack.regionScope('us-east-1');
    const cert = new sns.Topic(use1, 'Cert');
    const dist = new ssm.StringParameter(stack, 'Dist', { stringValue: cert.topicArn });
    const alarms = stack.regionScope('us-east-1', { group: 'Alarms' });
    new ssm.StringParameter(alarms, 'Alarm', { stringValue: dist.parameterName });
    return { stack, use1, alarms };
  };

  test('snapshot: main, twin and group templates', () => {
    const { stack, use1, alarms } = createGroupedStacks(new App());
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot('main-grouped');
    expect(Template.fromStack(use1).toJSON()).toMatchSnapshot('twin-grouped');
    expect(Template.fromStack(alarms).toJSON()).toMatchSnapshot('group');
  });

  test('same (region, group) returns the same stack, different groups return different stacks', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    const a = stack.regionScope('us-east-1', { group: 'A' });

    expect(stack.regionScope('us-east-1', { group: 'A' })).toBe(a);
    expect(stack.regionScope('us-east-1', { group: 'B' })).not.toBe(a);
    expect(stack.regionScope('us-east-1')).not.toBe(a);
  });

  test('group stack is a sibling named `<stackName>-<group>`; the default twin keeps the shared name', () => {
    const app = new App();
    const stack = new MultiRegionStack(app, 'MyStack', { env });
    const group = stack.regionScope('us-east-1', { group: 'Alarms' });

    expect(group.node.scope).toBe(app);
    expect(group.stackName).toBe(`${stack.stackName}-Alarms`);
    expect(group.account).toBe(stack.account);
    expect(group.region).toBe('us-east-1');
    expect(stack.regionScope('us-east-1').stackName).toBe(stack.stackName);
  });

  test('a group in the stack own region creates a sibling stack in the main region', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    const group = stack.regionScope('ap-northeast-1', { group: 'Extra' });

    expect(group).not.toBe(stack);
    expect(group.region).toBe('ap-northeast-1');
    expect(group.stackName).toBe(`${stack.stackName}-Extra`);
  });

  test('group contains a placeholder and inherits description, terminationProtection and tags', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', {
      env,
      description: 'my description',
      terminationProtection: true,
      tags: { CostCenter: 'X' },
    });
    const group = stack.regionScope('us-east-1', { group: 'Alarms' });

    Template.fromStack(group).resourceCountIs('AWS::CloudFormation::WaitConditionHandle', 1);
    expect(Template.fromStack(group).toJSON().Description).toBe('my description');
    expect(group.terminationProtection).toBe(true);
    expect(group.tags.tagValues()).toEqual({ CostCenter: 'X' });
  });

  test('the cert/dist/alarm shape synthesizes without a cycle, deploy order derived from references', () => {
    const app = new App();
    const { stack, use1, alarms } = createGroupedStacks(app);
    const asm = app.synth();

    const mainDeps = asm.getStackArtifact(stack.artifactId).dependencies.map((d) => d.id);
    const groupDeps = asm.getStackArtifact(alarms.artifactId).dependencies.map((d) => d.id);
    expect(mainDeps).toContain(use1.artifactId);
    expect(groupDeps).toContain(stack.artifactId);
  });

  test('both reference directions in one twin fail with guidance to use a group', () => {
    const app = new App();
    const stack = new MultiRegionStack(app, 'MyStack', { env });
    const use1 = stack.regionScope('us-east-1');
    const cert = new sns.Topic(use1, 'Cert');
    const dist = new ssm.StringParameter(stack, 'Dist', { stringValue: cert.topicArn });
    new ssm.StringParameter(use1, 'Alarm', { stringValue: dist.parameterName });

    let error: Error | undefined;
    try {
      app.synth();
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/cyclic reference/);
    expect(error?.message).toMatch(/regionScope\('us-east-1', \{ group: 'Alarms' \}\)/);
  });

  test('a group that is not a dependency of the main stack warns that plain deploy skips it', () => {
    const { alarms } = createGroupedStacks(new App());
    Annotations.fromStack(alarms).hasWarning('*', Match.stringLikeRegexp('.*will NOT deploy it.*'));
  });

  test('a group referenced by the main stack is upstream of it and does not warn', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    const group = stack.regionScope('us-east-1', { group: 'Waf' });
    const topic = new sns.Topic(group, 'Topic');
    new ssm.StringParameter(stack, 'Param', { stringValue: topic.topicArn });

    Annotations.fromStack(group).hasNoWarning(
      '*',
      Match.stringLikeRegexp('.*will NOT deploy it.*'),
    );
  });
});

describe('validation', () => {
  test('fails when env.region is not specified', () => {
    expect(() => new MultiRegionStack(new App(), 'MyStack', {})).toThrow(
      /requires a concrete `env\.region`/,
    );
  });

  test('an account-agnostic stack is allowed and the twin stays account-agnostic', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', {
      env: { region: 'ap-northeast-1' },
    });
    const use1 = stack.regionScope('us-east-1');

    expect(use1.region).toBe('us-east-1');
    expect(Token.isUnresolved(use1.account)).toBe(true);
  });

  test('fails when regionScope is called with an unresolved token', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    expect(() => stack.regionScope(Aws.REGION)).toThrow(/concrete region/);
  });

  test.each(['1abc', 'a_b', 'has space', '-abc', ''])(
    'fails for invalid group name %j',
    (group) => {
      const stack = new MultiRegionStack(new App(), 'MyStack', { env });
      expect(() => stack.regionScope('us-east-1', { group })).toThrow(
        /group must start with a letter/,
      );
    },
  );

  test('fails when the group makes the stack name exceed 128 characters', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', {
      env,
      stackName: 'a'.repeat(120),
    });
    expect(() => stack.regionScope('us-east-1', { group: 'b'.repeat(20) })).toThrow(
      /exceed 128 characters/,
    );
  });
});
