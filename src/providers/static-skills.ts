import type {
  SkillBundle,
  SkillProvider,
} from '../core/types.js';
import { filterSkills } from '../core/skills.js';

export type StaticSkillProviderConfig = {
  kind?: string;
  skills: SkillBundle[];
};

export class StaticSkillProvider implements SkillProvider {
  readonly kind: string;
  private readonly skills: SkillBundle[];

  constructor(config: StaticSkillProviderConfig) {
    this.kind = config.kind || 'static-skills';
    this.skills = config.skills.map(skill => ({
      ...skill,
      files: skill.files ? [...skill.files] : undefined,
      metadata: skill.metadata ? { ...skill.metadata } : undefined,
    }));
  }

  async listSkills(args?: { names?: string[] }): Promise<SkillBundle[]> {
    return filterSkills({
      skills: this.skills,
      names: args?.names,
    }).map(skill => ({
      ...skill,
      files: skill.files ? [...skill.files] : undefined,
      metadata: skill.metadata ? { ...skill.metadata } : undefined,
    }));
  }
}
