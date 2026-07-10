import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MultiRegionStack } from '../src';

const app = new App();

// Migration shape: the regions do NOT share a stack name, and the twin/group
// carry their own construct IDs. The main stack, its us-east-1 twin, and a
// us-east-1 group are each named AND identified independently (as a hand-split
// deployment would be), via `stackName` + `regionStackOverrides`. This proves:
//   - the shared-name convention is not required for the cross-region
//     references to resolve in EITHER direction (main -> twin, group -> main);
//   - a `constructId` override drives the twin/group construct path (and thus
//     any full-path-derived physical name) end-to-end.
//
// Account is intentionally left environment-agnostic so the committed snapshot
// contains no account ID; it resolves from credentials at deploy.
const stack = new MultiRegionStack(app, 'MultiRegionStackRenameInteg', {
  env: { region: 'ap-northeast-1' },
  stackName: 'MrsRenameV2-Tokyo',
  regionStackOverrides: {
    'us-east-1': {
      defaultStack: { stackName: 'MrsRenameV2-Virginia', constructId: 'MrsRenameV2-Virginia' },
      groupStacks: {
        Alarms: {
          stackName: 'MrsRenameV2-Virginia-Alarms',
          constructId: 'MrsRenameV2-Virginia-Alarms',
        },
      },
    },
  },
});

// Twin (us-east-1, renamed) — stands in for an ACM certificate; the main stack
// references it (main -> twin).
const cert = new sns.Topic(stack.regionScope('us-east-1'), 'CertStandIn');

// Main-region resource consuming the twin's value — stands in for the
// CloudFront distribution.
const dist = new ssm.StringParameter(stack, 'DistStandIn', { stringValue: cert.topicArn });

// Group (us-east-1, renamed) referencing back into the main stack — stands in
// for a CloudWatch alarm on CloudFront metrics (group -> main). Renaming the
// group exercises the groupStacks stackName/constructId override end-to-end.
new ssm.StringParameter(stack.regionScope('us-east-1', { group: 'Alarms' }), 'AlarmStandIn', {
  parameterName: '/cdk-multi-region-stack/integ-rename-v2/alarm',
  stringValue: dist.parameterName,
});

new IntegTest(app, 'MultiRegionStackRenameTest', {
  // The group is the most-downstream stack, so deploying it pulls in the main
  // stack and the twin through dependencies — the whole renamed chain, in order.
  testCases: [stack.regionScope('us-east-1', { group: 'Alarms' })],
  // Pin the region so the cross-region wiring is guaranteed regardless of
  // the credentials' default region.
  regions: ['ap-northeast-1'],
  diffAssets: true,
});

// No API-call assertions here for the same reason as integ.multi-region-stack:
// the assertions stack cannot be pinned to a specific region. Successful
// deployment already proves both reference directions resolve against the
// twin's and group's overridden names.
