import path from 'node:path';

import { DevGuardError } from '../../shared/errors.js';
import type { Limits } from '../../shared/limits.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../shared/limits.js';
import { NOT_A_REPO, type RepoState } from '../diff/git-port.js';

export interface ProjectGitPort {
  /** Returns null when git cannot be started. */
  version(signal?: AbortSignal): Promise<string | null>;
  repoState(signal?: AbortSignal): Promise<RepoState>;
}

export interface ProjectInfo {
  schemaVersion: 1;
  server: { name: string; version: string };
  runtime: { node: string; platform: string };
  workspace: {
    /** Folder name only; the full path stays in the server log. */
    name: string;
    isGitRepo: boolean;
    isRepoRoot: boolean;
    branch: string | null;
    headShortSha: string | null;
    detached: boolean;
  };
  git: { available: boolean; version: string | null; error?: string };
  languageScope: string[];
  effectiveLimits: {
    maxResponseBytes: number;
    gitTimeoutMs: number;
    toolTimeoutMs: number;
    maxFilesScanned: number;
    maxHunksPerFile: number;
    maxSourceFiles: number;
    maxSourceFileBytes: number;
    defaultPageSize: number;
    maxPageSize: number;
  };
  tools: string[];
}

export interface ProjectInfoDeps {
  git: ProjectGitPort;
  workspaceRoot: string;
  limits: Limits;
  server: { name: string; version: string };
  toolNames: readonly string[];
}

export class ProjectInfoService {
  constructor(private readonly deps: ProjectInfoDeps) {}

  async getInfo(signal?: AbortSignal): Promise<ProjectInfo> {
    const { git, limits, workspaceRoot, server, toolNames } = this.deps;

    const version = await git.version(signal);
    let state: RepoState = { ...NOT_A_REPO };
    let gitError: string | undefined;
    if (version !== null) {
      try {
        state = await git.repoState(signal);
      } catch (error) {
        // For example "dubious ownership": report it instead of failing the whole call.
        if (error instanceof DevGuardError && error.code === 'GIT_FAILED') gitError = error.message;
        else throw error;
      }
    }

    const gitInfo: ProjectInfo['git'] = { available: version !== null, version };
    if (gitError !== undefined) gitInfo.error = gitError;

    return {
      schemaVersion: 1,
      server: { ...server },
      runtime: { node: process.versions.node, platform: process.platform },
      workspace: {
        name: path.basename(workspaceRoot),
        isGitRepo: state.isRepo,
        isRepoRoot: state.isRepoRoot,
        branch: state.branch,
        headShortSha: state.headSha?.slice(0, 7) ?? null,
        detached: state.detached,
      },
      git: gitInfo,
      languageScope: ['typescript', 'javascript'],
      effectiveLimits: {
        maxResponseBytes: limits.maxResponseBytes,
        gitTimeoutMs: limits.gitTimeoutMs,
        toolTimeoutMs: limits.toolTimeoutMs,
        maxFilesScanned: limits.maxFilesScanned,
        maxHunksPerFile: limits.maxHunksPerFile,
        maxSourceFiles: limits.maxSourceFiles,
        maxSourceFileBytes: limits.maxSourceFileBytes,
        defaultPageSize: DEFAULT_PAGE_SIZE,
        maxPageSize: MAX_PAGE_SIZE,
      },
      tools: [...toolNames],
    };
  }
}
