import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App, Stage } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MultiRegionStack } from '../src';

// Stage variant: the stack lives inside a Stage, so the twin is created under
// that same Stage (Stage.of(this) ?? App) rather than directly under the App.
// Both main and twin artifact ids get the Stage prefix; cross-region wiring is
// otherwise identical to the base case (see integ.multi-region-stack.ts).
const app = new App();
const stage = new Stage(app, 'Prod');

// Account is intentionally left environment-agnostic so the committed
// snapshot contains no account ID; it resolves from credentials at deploy.
const stack = new MultiRegionStack(stage, 'MultiRegionStackStageInteg', {
  env: { region: 'ap-northeast-1' },
});

// Twin (us-east-1) resource — stands in for an ACM certificate / WAF WebACL
const topic = new sns.Topic(stack.regionScope('us-east-1'), 'GlobalTopic');

// Main-region resource consuming the twin's value across regions
new ssm.StringParameter(stack, 'Consumer', {
  parameterName: '/cdk-multi-region-stack/integ-stage/consumer',
  stringValue: topic.topicArn,
});

new IntegTest(app, 'MultiRegionStackStageTest', {
  testCases: [stack],
  // Pin the region so the cross-region wiring is guaranteed regardless of
  // the credentials' default region.
  regions: ['ap-northeast-1'],
  diffAssets: true,
});

// No API-call assertions here: the assertions stack cannot be pinned to a
// specific region (see aws-cdk's own integ.cross-region-references.ts, which
// skips assertions for the same reason). Successful deployment already proves
// the cross-region reference resolves; the consumer parameter value was
// additionally verified manually (see docs/FINDINGS.md).
