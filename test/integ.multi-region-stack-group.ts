import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MultiRegionStack } from '../src';

const app = new App();

// Account is intentionally left environment-agnostic so the committed
// snapshot contains no account ID; it resolves from credentials at deploy.
const stack = new MultiRegionStack(app, 'MultiRegionStackGroupInteg', {
  env: { region: 'ap-northeast-1' },
});

// Twin (us-east-1) resource — stands in for an ACM certificate
const cert = new sns.Topic(stack.regionScope('us-east-1'), 'CertStandIn');

// Main-region resource consuming the twin's value — stands in for the
// CloudFront distribution
const dist = new ssm.StringParameter(stack, 'DistStandIn', {
  stringValue: cert.topicArn,
});

// Group (us-east-1) resource referencing back into the main stack — stands in
// for a CloudWatch alarm on CloudFront metrics. In a single twin this shape
// would be a cyclic reference; the group makes the three stacks a linear
// chain: twin -> main -> group.
new ssm.StringParameter(stack.regionScope('us-east-1', { group: 'Alarms' }), 'AlarmStandIn', {
  parameterName: '/cdk-multi-region-stack/integ-group/alarm',
  stringValue: dist.parameterName,
});

new IntegTest(app, 'MultiRegionStackGroupTest', {
  // The group is the most-downstream stack, so deploying it pulls in the main
  // stack and the twin through dependencies — the whole chain, in order.
  testCases: [stack.regionScope('us-east-1', { group: 'Alarms' })],
  // Pin the region so the cross-region wiring is guaranteed regardless of
  // the credentials' default region.
  regions: ['ap-northeast-1'],
  diffAssets: true,
});

// No API-call assertions here for the same reason as integ.multi-region-stack:
// the assertions stack cannot be pinned to a specific region. Successful
// deployment already proves both reference directions resolve (twin -> main
// and main -> group), which is exactly what the group feature exists for.
