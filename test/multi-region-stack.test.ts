import { App, Aws, Stage } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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

describe('validation', () => {
  test('fails when env is not specified', () => {
    expect(() => new MultiRegionStack(new App(), 'MyStack', {})).toThrow(/requires a concrete env/);
  });

  test('fails when only region is specified', () => {
    expect(
      () => new MultiRegionStack(new App(), 'MyStack', { env: { region: 'ap-northeast-1' } }),
    ).toThrow(/requires a concrete env/);
  });

  test('fails when regionScope is called with an unresolved token', () => {
    const stack = new MultiRegionStack(new App(), 'MyStack', { env });
    expect(() => stack.regionScope(Aws.REGION)).toThrow(/concrete region/);
  });
});
