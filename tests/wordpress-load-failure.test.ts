import test from "node:test";
import assert from "node:assert/strict";
import { parseWordPressLoadFailure, wordpressLoadFailureMessage } from "../src/lib/connectors/wordpress-load-failure";
const root = "/home/account/site";
const failure = (overrides = {}) => ({ data: { error: { type: 1, file: root + "/wp-content/plugins/wp-rocket/inc/ThirdParty/Plugins/CDN/Cloudflare.php", line: 496, message: "Uncaught TypeError: substr(): Argument #1 ($string) must be of type string, int given\nsecret-token-in-stack", ...overrides } } });
test("Erreur WordPress : diagnostic précis, sans message PHP, trace ou chemin privé", () => {
  const result = parseWordPressLoadFailure(failure(), root)!;
  assert.equal(result.knownIssue, "wp-rocket-wordpress-7.1");
  assert.equal(result.component, "wp-rocket");
  assert.equal(result.line, 496);
  assert.match(wordpressLoadFailureMessage(result), /3\.23\.2\.2/);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|\/home\/|message|stack/);
  const theme = parseWordPressLoadFailure(failure({ file: root + "/wp-content/themes/theme/inc/code.php", message: "Uncaught Error: secret" }), root)!;
  assert.equal(theme.kind, "theme");
  assert.equal(theme.knownIssue, undefined);
  assert.match(wordpressLoadFailureMessage(theme), /thème theme/);
});
test("Erreur WordPress : pas d’attribution à un autre site, une traversée ou un message arbitraire", () => {
  for (const changes of [{ file: "/home/other/site/wp-content/plugins/wp-rocket/file.php" }, { file: root + "/wp-content/plugins/a/../wp-rocket/file.php" }, { file: root + "/wp-content/plugins/a\nsecret/file.php" }, { file: root + "/wp-config.php" }, { type: 2 }, { message: "x".repeat(8193) }]) assert.equal(parseWordPressLoadFailure(failure(changes), root), undefined);
  assert.equal(parseWordPressLoadFailure({ message: "wp-rocket critical error" }, root), undefined);
});
