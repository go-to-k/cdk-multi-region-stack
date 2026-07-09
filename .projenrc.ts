import { awscdk } from 'projen';
import { NodePackageManager, TrailingComma } from 'projen/lib/javascript';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'go-to-k',
  authorAddress: '24818752+go-to-k@users.noreply.github.com',
  // 2.254.0: `@aws-cdk/core:defaultCrossStackReferences` (strong/weak/both) introduced
  cdkVersion: '2.254.0',
  defaultReleaseBranch: 'main',
  // ts-node cannot run the TS 7 (native) compiler, so pin the 5.x toolchain
  jsiiVersion: '~5.9.0',
  typescriptVersion: '~5.9.0',
  name: 'cdk-multi-region-stack',
  projenrcTs: true,
  repositoryUrl: 'https://github.com/go-to-k/cdk-multi-region-stack',
  description:
    'A CDK Stack that lets you place resources in other regions while keeping them in one logical stack',
  prettier: true,
  prettierOptions: {
    settings: {
      singleQuote: true,
      jsxSingleQuote: true,
      trailingComma: TrailingComma.ALL,
      semi: true,
      printWidth: 100,
    },
  },
  eslintOptions: {
    dirs: ['src'],
    prettier: true,
    ignorePatterns: ['example/**/*', 'test/*.snapshot/**/*', '*.d.ts'],
  },
  license: 'Apache-2.0',
  keywords: [
    'aws',
    'cdk',
    'aws-cdk',
    'multi-region',
    'cross-region',
    'stack',
    'cloudfront',
    'acm',
    'waf',
  ],
  gitignore: ['*.js', '*.d.ts', 'cdk.out/', '.DS_Store'],
  githubOptions: {
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: ['feat', 'fix', 'chore', 'docs', 'test', 'refactor', 'ci'],
      },
    },
  },
  packageManager: NodePackageManager.PNPM,
  workflowNodeVersion: '24',
  npmTrustedPublishing: true,
});
project.synth();
