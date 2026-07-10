import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MultiRegionStack } from '../src';

const app = new App();

// Migration shape: the two regions do NOT share a stack name. The main stack
// and the twin are named independently (as a hand-split deployment would be),
// proving the shared-name convention is not required for the cross-region
// reference to resolve.
//
// Account is intentionally left environment-agnostic so the committed snapshot
// contains no account ID; it resolves from credentials at deploy.
const stack = new MultiRegionStack(app, 'MultiRegionStackRenameInteg', {
  env: { region: 'ap-northeast-1' },
  stackName: 'MrsRenameInteg-Tokyo',
});

// Twin (us-east-1) with an independent name — stands in for an ACM
// certificate / WAF WebACL living in the pre-existing us-east-1 stack.
const topic = new sns.Topic(
  stack.regionScope('us-east-1', { stackName: 'MrsRenameInteg-Virginia' }),
  'GlobalTopic',
);

// Main-region resource consuming the twin's value across regions. Under strong
// references the export writer/reader wiring is name-independent; the deploy
// succeeding proves the differently-named twin is referenced correctly.
new ssm.StringParameter(stack, 'Consumer', {
  parameterName: '/cdk-multi-region-stack/integ-rename/consumer',
  stringValue: topic.topicArn,
});

new IntegTest(app, 'MultiRegionStackRenameTest', {
  testCases: [stack],
  // Pin the region so the cross-region wiring is guaranteed regardless of
  // the credentials' default region.
  regions: ['ap-northeast-1'],
  diffAssets: true,
});

// No API-call assertions here for the same reason as integ.multi-region-stack:
// the assertions stack cannot be pinned to a specific region. Successful
// deployment already proves the reference resolves against the twin's
// overridden name.
