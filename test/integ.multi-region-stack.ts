import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MultiRegionStack } from '../src';

const app = new App();

// Account is intentionally left environment-agnostic so the committed
// snapshot contains no account ID; it resolves from credentials at deploy.
const stack = new MultiRegionStack(app, 'MultiRegionStackInteg', {
  env: { region: 'ap-northeast-1' },
});

// Twin (us-east-1) resource — stands in for an ACM certificate / WAF WebACL
const topic = new sns.Topic(stack.regionScope('us-east-1'), 'GlobalTopic');

// Main-region resource consuming the twin's value across regions
new ssm.StringParameter(stack, 'Consumer', {
  parameterName: '/cdk-multi-region-stack/integ/consumer',
  stringValue: topic.topicArn,
});

new IntegTest(app, 'MultiRegionStackTest', {
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
