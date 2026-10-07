import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadSkills,
  SKILLS_CHANGE_EVENT,
  hasNativeCommands,
  subscribeSkills,
  mergeCatalog,
  peekSkills,
  skillCatalogIssue,
  skillCatalogKey,
  type Skill,
  type SkillCatalogContext,
} from "../../skills/model/skills";
import type { HarnessId } from "../model/session";

export type ComposerSkillContextToken = {
  key: string;
  generation: number;
};

type ComposerSkillState = {
  key: string;
  skills: Skill[];
};

export function nextComposerSkillContextToken(
  current: ComposerSkillContextToken | null,
  key: string,
): ComposerSkillContextToken {
  if (current?.key === key) return current;
  return { key, generation: (current?.generation ?? -1) + 1 };
}

export function visibleComposerSkills(
  state: ComposerSkillState,
  currentKey: string,
  cached: Skill[] | null,
  fallback: Skill[],
): Skill[] {
  return state.key === currentKey ? state.skills : (cached ?? fallback);
}

export function useComposerSkills(input: {
  harness: HarnessId;
  executionCwd: string;
  sessionId?: string;
  pickerOpen: boolean;
}) {
  const context = useMemo<SkillCatalogContext>(
    () => ({
      harness: input.harness,
      cwd: input.executionCwd,
      sessionId: input.sessionId,
    }),
    [input.executionCwd, input.harness, input.sessionId],
  );
  const contextKey = skillCatalogKey(context);
  const fallback = useMemo<Skill[]>(
    () => (hasNativeCommands(input.harness) ? [] : mergeCatalog([])),
    [input.harness],
  );
  const currentToken = useRef<ComposerSkillContextToken | null>(null);
  currentToken.current = nextComposerSkillContextToken(
    currentToken.current,
    contextKey,
  );
  const contextToken = currentToken.current;
  const [state, setState] = useState<ComposerSkillState>(() => ({
    key: contextKey,
    skills: peekSkills(context) ?? fallback,
  }));

  const isCurrent = useCallback(
    (token: ComposerSkillContextToken) => currentToken.current === token,
    [],
  );
  const commit = useCallback(
    (token: ComposerSkillContextToken, skills: Skill[]) => {
      if (!isCurrent(token)) return false;
      setState({ key: token.key, skills });
      return true;
    },
    [isCurrent],
  );
  const refresh = useCallback(
    async (options?: { refresh?: boolean }) => {
      const token = contextToken;
      const next = await loadSkills(context, options);
      return commit(token, next);
    },
    [commit, context, contextToken],
  );

  useEffect(() => {
    return subscribeSkills(context, (skills) => commit(contextToken, skills));
  }, [commit, context, contextToken]);

  useEffect(() => {
    const cached = peekSkills(context);
    if (cached) commit(contextToken, cached);
    void refresh().catch(() => undefined);
  }, [commit, context, contextToken, refresh]);

  useEffect(() => {
    const onChange = (): void => {
      if (!hasNativeCommands(context.harness)) void refresh({ refresh: true });
    };
    window.addEventListener(SKILLS_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(SKILLS_CHANGE_EVENT, onChange);
  }, [context.harness, refresh]);

  useEffect(() => {
    if (!input.pickerOpen) return;
    // The backend watcher invalidates file catalogs, so opening the picker
    // reads the cache; native harnesses keep their TTL inside loadSkills.
    void refresh().catch(() => undefined);
  }, [input.pickerOpen, refresh]);

  return {
    contextKey,
    contextToken,
    isCurrent,
    refresh,
    issue: skillCatalogIssue(context),
    skills: visibleComposerSkills(
      state,
      contextKey,
      peekSkills(context),
      fallback,
    ),
  };
}
