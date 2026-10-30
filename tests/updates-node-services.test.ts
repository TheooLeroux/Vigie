import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeServiceConcurrency, prepareNodeServices } from "../src/lib/updates/node-services";
import type { NodeUpdateChecks } from "../src/lib/updates/node";
import { nodeValidationRuntime } from "../src/lib/updates/node";
import { ApiError } from "../src/lib/http";
import { runCommand } from "../src/lib/updates/process";

const checks = (): NodeUpdateChecks => ({ resolved: async () => {}, image: async () => {}, validated: async () => {} });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(roots = ["one", "two"]) {
  const folder = await mkdtemp(join(tmpdir(), "vigie-services-test-")), names: string[] = [];
  for (const root of roots) {
    const prefix = root ? root + "/" : "";
    await mkdir(join(folder, root), { recursive: true });
    for (const [name, content] of Object.entries({ "package.json": JSON.stringify({ name: root || "app", version: "1.0.0", scripts: { test: "node --test" } }), "package-lock.json": "{}", "source.js": "original" })) {
      await writeFile(join(folder, prefix + name), content);
      names.push(prefix + name);
    }
  }
  return { folder, names };
}
async function proposal(folder: string, roots: string[]) {
  const root = roots[0], path = `${root}/package.json`;
  const manifest = JSON.parse(await readFile(join(folder, path), "utf8"));
  await writeFile(join(folder, path), JSON.stringify({ ...manifest, version: "1.1.0", engines: { node: "24.22.1" } }));
  return { allowed: new Set([path]), warnings: [`${root}: prepared`] };
}

test("Services : ressources bornées, au plus deux préparations", () => {
  assert.equal(nodeServiceConcurrency(8, 16 * 1024 ** 3), 2);
  assert.equal(nodeServiceConcurrency(1, 16 * 1024 ** 3), 1);
  assert.equal(nodeServiceConcurrency(4, 4 * 1024 ** 3), 1);
  assert.equal(nodeServiceConcurrency(64, 128 * 1024 ** 3), 2);
});

test("Services : l’image de validation est figée une seule fois pour toutes les reprises et tâches", async () => {
  let reads = 0;
  const image = "sha256:" + "a".repeat(64);
  const runtime = nodeValidationRuntime("24.22.1", async (_command, args) => {
    assert.deepEqual(args, ["image", "inspect", "node:24.22.1-bookworm", "--format", "{{.Id}}"]);
    reads++;
    return reads === 1 ? image : "sha256:" + "b".repeat(64);
  });
  assert.deepEqual(await Promise.all([runtime.image(), runtime.image(), runtime.image()]), [image, image, image]);
  assert.equal(await runtime.image(), image);
  assert.equal(reads, 1, "un build Docker concurrent ne doit pas changer l’image du sandbox");
  let inspections = 0, pulls = 0;
  const missing = nodeValidationRuntime("24.22.1", async (_command, args) => {
    if (args[0] === "pull") { pulls++; return "pulled"; }
    if (!inspections++) throw new ApiError("Missing image", 502);
    return image;
  });
  assert.equal(await missing.image(), image);
  assert.equal(inspections, 2);
  assert.equal(pulls, 1);
  const invalid = nodeValidationRuntime("24.22.1", async () => "unidentified");
  await assert.rejects(invalid.image(), /identité exacte/);
});

test("Services : téléchargements privés par service et exécution, supprimés à la fermeture", async () => {
  const first = nodeValidationRuntime("24.22.1"), second = nodeValidationRuntime("24.22.1");
  let path = "";
  try {
    const [a, b] = await Promise.all([first.downloads!("app"), first.downloads!("app")]);
    path = a;
    assert.equal(a, b);
    assert.notEqual(a, await first.downloads!("other"));
    assert.notEqual(a, await second.downloads!("app"));
    await writeFile(join(a, "content"), "cached bytes");
  } finally { await first.dispose!(); await second.dispose!(); }
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.throws(() => first.downloads!("app"), /fermé/);
});

test("Services : préparations simultanées, reprises privées et validation de l’ensemble avant fusion", async () => {
  const { folder, names } = await fixture(), preparationBarrier = deferred(), validationBarrier = deferred();
  const retries: unknown[] = [], directories: string[] = [];
  let preparing = 0, validating = 0, maxPreparing = 0, maxValidating = 0;
  try {
    const result = await prepareNodeServices(folder, ["one", "two"], names, "24.22.1", checks, {
      concurrency: 2,
      prepare: async (working, roots, _names, _node, _transport, _docker, retry) => {
        directories.push(working);
        retries.push(retry!.limits);
        retry!.limits.set(roots[0], { fixture: "local" });
        maxPreparing = Math.max(maxPreparing, ++preparing);
        if (preparing === 2) preparationBarrier.resolve();
        await preparationBarrier.promise;
        const other = roots[0] === "one" ? "two" : "one";
        assert.equal(JSON.parse(await readFile(join(working, other, "package.json"), "utf8")).version, "1.0.0");
        assert.equal(retry!.limits.has(other), false, "les limites de reprise restent locales");
        const candidate = await proposal(working, roots);
        assert.equal(JSON.parse(await readFile(join(folder, roots[0], "package.json"), "utf8")).version, "1.0.0", "aucune fusion anticipée");
        preparing--;
        return candidate;
      },
      validate: async working => {
        directories.push(working);
        maxValidating = Math.max(maxValidating, ++validating);
        if (validating === 2) validationBarrier.resolve();
        await validationBarrier.promise;
        for (const root of ["one", "two"]) assert.equal(JSON.parse(await readFile(join(working, root, "package.json"), "utf8")).version, "1.1.0", "chaque validation voit les propositions assemblées");
        await writeFile(join(working, "private-output"), "not copied");
        validating--;
      },
    });
    assert.equal(maxPreparing, 2);
    assert.equal(maxValidating, 2);
    assert.notEqual(retries[0], retries[1]);
    assert.equal(result.allowed.size, 2);
    for (const root of ["one", "two"]) assert.equal(JSON.parse(await readFile(join(folder, root, "package.json"), "utf8")).version, "1.1.0");
    await assert.rejects(stat(join(folder, "private-output")), { code: "ENOENT" });
    for (const path of directories) await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

for (const failure of ["source", "ownership", "final-source", "combination"]) {
  test(`Services : ${failure} interdit toute fusion et conserve les sources originales`, async () => {
    const { folder, names } = await fixture();
    const originals = await Promise.all(names.map(name => readFile(join(folder, name), "utf8")));
    try {
      await assert.rejects(prepareNodeServices(folder, ["one", "two"], names, "24.22.1", checks, {
        concurrency: 2,
        prepare: async (working, roots) => {
          const candidate = await proposal(working, roots);
          if (roots[0] === "one") {
            if (failure === "source") await writeFile(join(working, "two/source.js"), "changed");
            if (failure === "ownership") candidate.allowed.add("two/package.json");
          }
          return candidate;
        },
        validate: async working => {
          if (failure === "combination") throw Error("Combined inputs rejected");
          if (failure === "final-source") await writeFile(join(working, "one/source.js"), "changed");
        },
      }));
      for (const [index, name] of names.entries()) assert.equal(await readFile(join(folder, name), "utf8"), originals[index]);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}

test("Services : un échec attend les tâches déjà lancées avant de supprimer leurs répertoires", async () => {
  const { folder, names } = await fixture(), secondStarted = deferred(), releaseSecond = deferred();
  let secondDirectory = "", finished = false;
  try {
    const running = prepareNodeServices(folder, ["one", "two"], names, "24.22.1", checks, {
      concurrency: 2,
      prepare: async (working, roots) => {
        if (roots[0] === "one") { await secondStarted.promise; throw Error("first rejected"); }
        secondDirectory = working;
        secondStarted.resolve();
        await releaseSecond.promise;
        await stat(working);
        return proposal(working, roots);
      },
      validate: async () => { throw Error("must not validate"); },
    });
    const rejection = assert.rejects(running, /first rejected/).then(() => { finished = true; });
    await secondStarted.promise;
    assert.equal(finished, false);
    await stat(secondDirectory);
    releaseSecond.resolve();
    await rejection;
    await assert.rejects(stat(secondDirectory), { code: "ENOENT" });
  } finally { releaseSecond.resolve(); await rm(folder, { recursive: true, force: true }); }
});

test("Services : un échec annule les validations actives, conserve la cause et ne lance pas le service suivant", async () => {
  const { folder, names } = await fixture(["one", "two", "three"]), secondStarted = deferred();
  let cancelled = false, thirdStarted = false, secondDirectory = "";
  try {
    await assert.rejects(prepareNodeServices(folder, ["one", "two", "three"], names, "24.22.1", checks, {
      concurrency: 2,
      prepare: async (working, roots, _names, _node, _transport, _docker, retry) => {
        if (roots[0] === "one") { await secondStarted.promise; throw new ApiError("Trivy : image refusée", 422); }
        if (roots[0] === "three") { thirdStarted = true; throw Error("must not start"); }
        secondDirectory = working;
        await new Promise<void>(resolve => { retry!.runtime!.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); secondStarted.resolve(); });
        await stat(working);
        throw new ApiError("interruption secondaire", 499);
      },
      validate: async () => { throw Error("must not validate"); },
    }), /Trivy : image refusée/);
    assert.equal(cancelled, true);
    assert.equal(thirdStarted, false);
    await assert.rejects(stat(secondDirectory), { code: "ENOENT" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Processus : une annulation interrompt une commande active et refuse un nouveau lancement", async () => {
  const cancellation = new AbortController();
  const running = runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(running, /Validation interrompue/);
  await assert.rejects(runCommand("must-not-exist", [], { signal: cancellation.signal }), /Validation interrompue/);
});

for (const layout of ["nested", "local", "workspace"]) {
  test(`Services : disposition ${layout} conserve le parcours coordonné`, async () => {
    const roots = layout === "nested" ? ["", "two"] : ["one", "two"], { folder, names } = await fixture(roots);
    try {
      if (layout !== "nested") {
        const manifest = JSON.parse(await readFile(join(folder, "one/package.json"), "utf8"));
        await writeFile(join(folder, "one/package.json"), JSON.stringify({ ...manifest, ...(layout === "local" ? { dependencies: { sibling: "file:../two" } } : { workspaces: ["subpackages/*"] }) }));
      }
      let calls = 0;
      await prepareNodeServices(folder, roots, names, "24.22.1", checks, {
        prepare: async (working, selected) => { calls++; assert.equal(working, folder); assert.deepEqual(selected, roots); return { allowed: new Set(), warnings: [] }; },
        validate: async () => { throw Error("not a split proposal"); },
      });
      assert.equal(calls, 1);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}
