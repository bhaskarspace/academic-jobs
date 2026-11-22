import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const root = new URL('../../', import.meta.url);
export const repoPath = (p) => new URL(p, root);

export async function loadYaml(rel) {
  return YAML.parse(await readFile(repoPath(rel), 'utf8'));
}

export async function loadConfig() {
  const [sources, categories, fields, concepts, institutions, linkouts] = await Promise.all([
    loadYaml('config/sources.yaml'),
    loadYaml('config/categories.yaml'),
    loadYaml('config/fields.yaml'),
    loadYaml('concepts/physics.yaml'),
    loadYaml('config/institutions.yaml'),
    loadYaml('config/linkouts.yaml'),
  ]);
  return { sources: sources.sources, categories, fields, concepts, institutions: institutions ?? {}, linkouts: linkouts ?? {} };
}
