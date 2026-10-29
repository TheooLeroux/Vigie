export const dependencyFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "composer.json", "composer.lock", "pyproject.toml", "uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "pylock.toml", "requirements.txt", "go.mod", "Cargo.lock", "Cargo.toml", "Gemfile.lock", "gems.locked"];
export function inspectableSource(path: string) {
  if (path.split("/").some(part => ["node_modules", ".git", ".next", ".env", "uploads", "vendor"].includes(part))) return false;
  const name = path.split("/").at(-1)!;
  return dependencyFiles.includes(name) || /\.(?:html?|[cm]?jsx?|tsx?|css)$/i.test(name) && !/(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)/i.test(name);
}
