import {readFileSync,unlinkSync} from "node:fs";
import {resolve} from "node:path";
import {createDecipheriv} from "node:crypto";
import {hostingConnections,saveHostingConnection,testHostingConnection} from "../src/lib/hosting-connections";
import {withAuditActor} from "../src/lib/audit-context";

// Private, encrypted transfer from a user-authorized credential creation in the browser.
// No plaintext token in files, command arguments, output or history.
async function main() {
  const path=resolve(".data","hosting-token-transfer.json");
  const transfer=JSON.parse(readFileSync(path,"utf8"));
  const connection=(await hostingConnections()).find(c => c.id === transfer.connectionId);
  if (!connection || transfer.v !== 1) throw new Error("Transfert non reconnu.");
  const encodedKey=process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(encodedKey)) throw new Error("Clé privée absente.");
  const decipher=createDecipheriv("aes-256-gcm",Buffer.from(encodedKey,"hex"),Buffer.from(transfer.iv,"base64"));
  decipher.setAAD(Buffer.from(`vigie:hosting-transfer:v1:${connection.id}`));
  decipher.setAuthTag(Buffer.from(transfer.tag,"base64"));
  const secret=Buffer.concat([decipher.update(Buffer.from(transfer.value,"base64")),decipher.final()]).toString("utf8");
  (await saveHostingConnection({...connection,authMode:"token",secret},connection.id));
  unlinkSync(path);
  const tested=await testHostingConnection(connection.id);
  console.log(JSON.stringify({name:tested.name,status:tested.status,domains:tested.domains.length,lastCheckedAt:tested.lastCheckedAt,error:tested.error}));
}
withAuditActor({name:"Configuration o2switch autorisée",email:""},main).catch(() => {console.error("Le transfert ou la vérification du jeton a échoué. Aucun secret n’est affiché.");process.exitCode=1;});
