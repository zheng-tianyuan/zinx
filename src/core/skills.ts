import type {
  SkillBundle,
  SkillManifest,
  SkillProvider,
} from './types.js';

export async function buildSkillManifest(args: {
  provider: SkillProvider;
  names?: string[];
  metadata?: Record<string, unknown>;
}): Promise<SkillManifest> {
  return {
    provider: args.provider.kind,
    skills: await args.provider.listSkills({
      names: args.names,
      metadata: args.metadata,
    }),
  };
}

export function renderSkillManifestForPrompt(manifest: SkillManifest): string {
  if (manifest.skills.length === 0) return '';

  return [
    `Skill provider: ${manifest.provider}`,
    'Available skills:',
    ...manifest.skills.map(renderSkillForPrompt),
  ].join('\n\n');
}

function renderSkillForPrompt(skill: SkillBundle): string {
  return [
    `## ${skill.name}`,
    skill.description ? `Description: ${skill.description}` : '',
    skill.trigger ? `Use when: ${skill.trigger}` : '',
    skill.content,
    skill.files?.length ? [
      'Supporting files:',
      ...skill.files.map(file => `- ${file.path}`),
    ].join('\n') : '',
  ].filter(Boolean).join('\n\n');
}

export function filterSkills(args: {
  skills: SkillBundle[];
  names?: string[];
}): SkillBundle[] {
  if (!args.names) return args.skills;
  const names = new Set(args.names);
  return args.skills.filter(skill => names.has(skill.name));
}

export function sanitizeSkillDirectoryName(name: string): string {
  const value = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'skill';
}
