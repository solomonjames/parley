/**
 * Curated OpenAPI presets: `yea openapi --preset github`. Each one picks the operations
 * an agent should have, overrides risk where the default is wrong, projects responses down
 * to what a model needs, and reads credentials from the environment (never shown to the model).
 */
import type { OpenApiOptions } from './openapi.js';
import type { Risk } from './types.js';

export interface Preset {
  description: string;
  spec: string;
  baseUrl: string;
  id: string;
  prefix: string;
  /** operationId → risk (operations not listed are not exposed). */
  ops: Record<string, Risk | 'read'>;
  headers(env: NodeJS.ProcessEnv): Record<string, string>;
  env: string[];
  project: NonNullable<OpenApiOptions['project']>;
}

const issueRow = [
  'number',
  'title',
  'state',
  'author=user.login',
  'labels[].name',
  'comments',
  'updated_at',
];
const prRow = [
  'number',
  'title',
  'state',
  'author=user.login',
  'draft',
  'head=head.ref',
  'base=base.ref',
  'updated_at',
];

export const PRESETS: Record<string, Preset> = {
  github: {
    description:
      'GitHub: read repos, issues and PRs; open issues, comment and label (low risk); open PRs (medium); merge PRs (high, always asks).',
    spec: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    baseUrl: 'https://api.github.com',
    id: 'api.github.com',
    prefix: 'github',
    ops: {
      'users/get-authenticated': 'read',
      'repos/list-for-authenticated-user': 'read',
      'repos/get': 'read',
      'repos/get-content': 'read',
      'issues/list-for-repo': 'read',
      'issues/get': 'read',
      'issues/list-comments': 'read',
      'pulls/list': 'read',
      'pulls/get': 'read',
      'search/issues-and-pull-requests': 'read',
      'issues/create': 'low',
      'issues/update': 'low',
      'issues/create-comment': 'low',
      'issues/add-labels': 'low',
      'pulls/create': 'medium',
      'pulls/merge': 'high',
    },
    env: ['GITHUB_TOKEN'],
    headers: (env) => ({
      'user-agent': '@yea-protocol/sdk',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(env.GITHUB_TOKEN
        ? { authorization: `Bearer ${env.GITHUB_TOKEN}` }
        : {}),
    }),
    project: {
      'users/get-authenticated': ['login', 'name', 'public_repos', 'html_url'],
      'repos/list-for-authenticated-user': [
        'full_name',
        'private',
        'language',
        'stars=stargazers_count',
        'open_issues=open_issues_count',
        'pushed_at',
      ],
      'repos/get': [
        'full_name',
        'description',
        'default_branch',
        'language',
        'stars=stargazers_count',
        'forks=forks_count',
        'open_issues=open_issues_count',
        'topics[]',
        'html_url',
      ],
      'repos/get-content': [
        'name',
        'path',
        'type',
        'size',
        'sha',
        'encoding',
        'content',
      ],
      'issues/list-for-repo': issueRow,
      'issues/get': [...issueRow, 'body', 'html_url'],
      'issues/list-comments': ['id', 'author=user.login', 'created_at', 'body'],
      'pulls/list': prRow,
      'pulls/get': [
        ...prRow,
        'mergeable',
        'additions',
        'deletions',
        'changed_files',
        'body',
        'html_url',
      ],
      'search/issues-and-pull-requests': [
        'number',
        'title',
        'state',
        'repo=repository_url',
        'author=user.login',
        'updated_at',
      ],
      'issues/create': ['number', 'title', 'html_url'],
      'issues/update': ['number', 'title', 'state', 'html_url'],
      'issues/create-comment': ['id', 'html_url'],
      'issues/add-labels': ['name'],
      'pulls/create': ['number', 'title', 'html_url'],
      'pulls/merge': ['merged', 'message', 'sha'],
    },
  },
  petstore: {
    description:
      'Swagger Petstore (a public demo API): pets, orders and users.',
    spec: 'https://petstore3.swagger.io/api/v3/openapi.json',
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    id: 'petstore3.swagger.io',
    prefix: 'petstore',
    ops: {
      findPetsByStatus: 'read',
      findPetsByTags: 'read',
      getPetById: 'read',
      getInventory: 'read',
      getOrderById: 'read',
      addPet: 'low',
      updatePet: 'low',
      placeOrder: 'low',
      deletePet: 'medium',
      deleteOrder: 'medium',
    },
    env: [],
    headers: () => ({}),
    project: {
      findPetsByStatus: ['id', 'name', 'status', 'category=category.name'],
      findPetsByTags: ['id', 'name', 'status', 'tags[].name'],
    },
  },
};

/** OpenAPI adapter options for a preset. */
export function presetOptions(
  p: Preset,
  env: NodeJS.ProcessEnv = process.env,
): OpenApiOptions {
  return {
    baseUrl: p.baseUrl,
    id: p.id,
    prefix: p.prefix,
    headers: p.headers(env),
    include: (_m, _path, op) =>
      typeof op.operationId === 'string' && op.operationId in p.ops,
    risk: (_m, _path, op) => {
      const access = p.ops[String(op.operationId)];

      return access === 'read' ? 'low' : access;
    },
    project: p.project,
  };
}
