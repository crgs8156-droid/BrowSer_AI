import { describe, expect, it } from 'vitest';
import { shouldResumeTask, type SafeTaskState } from '../../extension/src/agent/task-state';

function state(over: Partial<SafeTaskState>): SafeTaskState {
  return {
    taskId: 'agent-1',
    taskObjective: 'fill the form',
    currentStep: 2,
    steps: [],
    status: 'running',
    updatedAt: Date.now(),
    ...over,
  };
}

describe('task resume policy (Part D, restart-with-banner)', () => {
  it('resumes running tasks with an objective', () => {
    expect(shouldResumeTask(state({}))).toBe(true);
  });

  it('never resumes null, completed, stopped, or empty objectives', () => {
    expect(shouldResumeTask(null)).toBe(false);
    expect(shouldResumeTask(state({ status: 'completed' }))).toBe(false);
    expect(shouldResumeTask(state({ status: 'stopped' }))).toBe(false);
    expect(shouldResumeTask(state({ taskObjective: '   ' }))).toBe(false);
  });
});
