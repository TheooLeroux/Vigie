from pathlib import Path
from html import escape
from datetime import datetime
from zoneinfo import ZoneInfo
import json

folder=Path('.data/analysis')
data=json.loads((folder/'o2switch-latest.json').read_text(encoding='utf8'))
def e(value): return escape(str(value if value is not None else 'Non déterminé'))
def cell(value): return '<td>'+e(value)+'</td>'
def table(columns,rows):
    return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+e(c)+'</th>' for c in columns)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(cell(c) for c in row)+'</tr>' for row in rows)+'</tbody></table></div>'
labels={'wordpress':'WordPress identifié','wordpress-incomplete':'Arborescence WordPress incomplète','dolibarr':'Dolibarr','static-or-built':'HTML / export compilé','next-static-export':'Export statique Next.js','technical-directory':'Répertoire technique','empty':'Racine vide','other':'Non identifié','unreadable':'Lecture impossible','outside_home':'Hors périmètre'}
when=datetime.fromisoformat(data['collectedAt']).astimezone(ZoneInfo('Europe/Paris')).strftime('%d/%m/%Y à %H:%M')
parts=['''<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inventaire des deux comptes o2switch</title><style>
:root{font-family:system-ui,sans-serif;color:#24342c;background:#f5f6f3;font-size:15px}*{box-sizing:border-box}body{max-width:1180px;margin:auto;padding:34px 22px 70px}h1{font-size:32px;letter-spacing:-1px;margin:0 0 8px}h2{margin:0 0 14px;font-size:24px}h3{margin:25px 0 12px;font-size:18px}p{line-height:1.65}a{color:#28593c}nav{display:flex;gap:18px;margin:25px 0}.section{background:white;padding:26px;border:1px solid #e1e7dd;border-radius:10px;margin:24px 0}.muted,small{color:#69766a}.notice{background:#fff6e7;border-left:4px solid #b47c21;padding:16px 20px;margin:22px 0}.notice p{margin:8px 0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{padding:16px;background:#f2f5ee;border-radius:7px}.stat strong{display:block;font-size:25px;margin-top:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;background:#f2f5ee;font-weight:600}th,td{padding:10px 12px;border-bottom:1px solid #e7ebe3;vertical-align:top}td{overflow-wrap:anywhere}details{border-top:1px solid #e5e9e1;padding:16px 0}summary{cursor:pointer;font-weight:600;line-height:1.6}details p{font-size:13px}.path{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere}input{padding:12px 14px;border:1px solid #ccd6c8;border-radius:7px;min-width:270px;width:100%;margin:20px 0 0;font:inherit}.scope{font-size:13px}li{line-height:1.7;margin-bottom:7px}.hidden{display:none!important}@media(max-width:650px){body{padding:20px 12px}h1{font-size:25px}.section{padding:18px}.grid{grid-template-columns:1fr 1fr}table{min-width:600px}}@media print{body{max-width:none;background:white}input,nav{display:none}.section{break-inside:avoid}details{break-inside:avoid}}
</style><header><h1>Inventaire o2switch</h1>''',f'<p class="muted">Relevé du {e(when)} — lecture seule des deux comptes.</p></header>',
'<nav><a href="#account-0">o2switch 1 — gaz</a><a href="#account-1">o2switch 2 — canary</a><a href="#method">Méthode et limites</a></nav>',
'''<div class="notice"><strong>Points à traiter en priorité</strong><ul>
<li><strong>inuzin.xyz :</strong> arborescence WordPress incomplète, archive d’environ 6,2 Go, fichiers d’installation et copie de configuration de migration nommée <code>dup-wp-config-arc__…txt</code> dans la racine web. Le contenu des archives/configurations et leur accès HTTP n’ont pas été vérifiés.</li>
<li><strong>Deux CRM Dolibarr :</strong> versions observées 15.0.2 et 14.0.2. À intégrer au suivi, au même titre que les WordPress.</li>
<li><strong>Instances hors du parc :</strong> une préproduction WP Tiger en 6.7.2, prowo.pija4582.odns.fr en 7.1.3 et une copie « Old Francofil » en 6.2.3 sans domaine associé dans le relevé cPanel.</li>
<li><strong>PHP du second compte :</strong> profil natif 8.1.34. PHP 8.1 ne figure plus parmi les branches prises en charge en amont ; les éventuels correctifs du distributeur sont à confirmer. Le runtime HTTP de chaque site reste à vérifier.</li>
</ul></div><input id="search" type="search" placeholder="Filtrer les installations par domaine, nom ou chemin…" aria-label="Filtrer les installations">''']
for index,account in enumerate(data['accounts']):
    roots=account['roots']; wp=[r for r in roots if r['kind']=='wordpress'];crm=[r for r in roots if r['kind']=='dolibarr']
    parts.append(f'<section class="section" id="account-{index}"><h2>{e(account["name"])} · {e(account["host"])}</h2><div class="grid">')
    for label,value in [('Domaines / sous-domaines',len(account['domains'])),('WordPress identifiés',len(wp)),('Dolibarr',len(crm)),('Bases MySQL',len(account['databases']))]: parts.append(f'<div class="stat">{e(label)}<strong>{value}</strong></div>')
    profile=account['phpProfile']
    parts.append(f'<p><strong>PHP : {e(profile["version"])}</strong> · {e(profile["mode"])}.<br><small>{e(profile["scope"])}</small></p>')
    parts.append('<h3>Installations WordPress et CRM</h3>')
    rows=[]
    for root in roots:
        if root['kind'] not in ['wordpress','wordpress-incomplete','dolibarr']:continue
        rows.append([', '.join(root['domains']),labels[root['kind']],root.get('wordpressVersion') or root.get('applicationVersion') or 'Non déterminée',sum(bool(p.get('name')) for p in root.get('plugins',[])) if root['kind'].startswith('wordpress') else '—',len(root.get('themes',[])) if root['kind'].startswith('wordpress') else '—',', '.join(p['name'] for p in root['projects']) or 'Absent du parc'])
    parts.append(table(['Domaine','Application','Version lue','Extensions identifiées','Dossiers thèmes','Dans Vigie'],rows))
    if account.get('unmappedInstallations'):
        parts.append('<h3>Copies sans domaine rattaché dans cPanel</h3>'+table(['Répertoire','Type','Version'],[[r['path'],r['kind'],r['version']] for r in account['unmappedInstallations']]))
    parts.append('<h3>Détail des racines configurées</h3><p class="scope">Les extensions et thèmes ci-dessous sont présents sur disque. Leur activation n’a pas été vérifiée. Une racine vide ou technique ne permet pas de conclure que le domaine est hors ligne.</p>')
    for root in roots:
        title=', '.join(root['domains']);version=root.get('wordpressVersion') or root.get('applicationVersion')
        parts.append(f'<details class="installation"><summary>{e(title)} · {e(labels.get(root["kind"],root["kind"]))}{" · "+e(version) if version else ""}</summary><p class="path">{e(root["path"])}</p>')
        if root.get('projects'): parts.append('<p>Fiche existante : '+e(', '.join(p['name'] for p in root['projects']))+'</p>')
        for warning in root.get('findings',[])+root.get('warnings',[])+([root['enrichmentWarning']] if root.get('enrichmentWarning') else []):parts.append('<p>'+e(warning)+'</p>')
        if 'plugins' in root:
            parts.append('<h3>Extensions installées — activation inconnue</h3>'+table(['Dossier','Nom déclaré','Version lue','PHP minimal déclaré'],[[p['slug'],p.get('name') or 'En-tête non reconnu',p.get('version') or 'Non déterminée',p.get('requiresPhp') or 'Non indiqué'] for p in root['plugins']]))
            parts.append('<h3>Thèmes présents — thème actif inconnu</h3>'+table(['Dossier','Nom déclaré','Version lue','Thème parent déclaré'],[[p['slug'],p.get('name') or 'En-tête non reconnu',p.get('version') or 'Non déterminée',p.get('template') or '—'] for p in root.get('themes',[])]))
        if root.get('entries'):
            parts.append('<details><summary>Noms des fichiers et répertoires à la racine</summary>'+table(['Nom','Type','Taille (octets)'],[[p['name'],p['type'],p['bytes']] for p in root['entries']])+'</details>')
        if root.get('composer'):parts.append('<p>Paquets déclarés dans Composer : '+e(', '.join(root['composer']['requires']))+'. Versions installées non collectées.</p>')
        if root.get('package'):parts.append('<p>Paquets JavaScript déclarés : '+e(', '.join(root['package']['dependencies']))+'. Leur présence ne suffit pas à qualifier l’application de serveur Node.js.</p>')
        parts.append('</details>')
    parts.append('<h3>Bases MySQL</h3>'+table(['Base','Occupation déclarée (Mo décimaux)','Utilisateurs associés (nombre)'],[[d['name'],round(d['bytes']/1_000_000,1),d['userCount']] for d in account['databases']]))
    parts.append('<p class="scope">Les associations base/application n’ont pas été déduites des noms. Aucun contenu métier ni mot de passe de base n’a été lu.</p></section>')
parts.append('''<section class="section" id="method"><h2>Méthode et limites</h2><ul>
<li>Inventaire authentifié par l’API cPanel : domaines, racines documentaires, noms et métadonnées des fichiers, bases MySQL. Lecture du fichier WordPress <code>wp-includes/version.php</code>, des en-têtes d’extensions et des feuilles de style des thèmes. Aucun code hébergé n’a été exécuté.</li>
<li>Recherche complémentaire au premier niveau des répertoires du compte. Pas de recherche récursive complète ni d’ouverture des archives. Les répertoires techniques, mails et configurations privées n’ont pas fait l’objet d’une lecture de contenu.</li>
<li>Les fichiers de configuration des applications et les données métier des bases n’ont pas été ouverts. Le petit fichier <code>kek.php</code> d’inuzin.xyz a fait l’objet d’une lecture statique : aucun des appels dynamiques recherchés n’y a été identifié ; cela ne constitue pas une certification de sécurité.</li>
<li>Les versions sont celles des fichiers présents sur le serveur. Pas de vérification des sommes de contrôle, de l’activation des extensions ou de leur exposition réelle depuis Internet. Ce relevé ne constitue pas un audit de vulnérabilités.</li>
<li>L’API MultiPHP standard est refusée sur les deux comptes. Le sélecteur CloudLinux a été consulté en lecture seule via le terminal cPanel, puis le PHP natif du second compte avec <code>php -n -v</code>. Les surcharges par dossier et les versions PHP effectivement utilisées par chaque requête HTTP restent inconnues.</li>
</ul><p>Références : <a href="https://www.php.net/supported-versions.php">branches PHP prises en charge</a> ; <a href="https://docs.cloudlinux.com/cloudlinuxos/alt-ea_packages/">correctifs distributeur CloudLinux</a> ; <a href="https://docs.cloudlinux.com/cloudlinuxos/cloudlinux_os_components/">sélecteur PHP CloudLinux</a>.</p></section>
<script>document.getElementById('search').addEventListener('input',event=>{const query=event.target.value.toLocaleLowerCase('fr');document.querySelectorAll('.installation').forEach(entry=>entry.classList.toggle('hidden',!entry.textContent.toLocaleLowerCase('fr').includes(query)));});</script></html>''')
destination=folder/'o2switch-report.html';destination.write_text(''.join(parts),encoding='utf8');print(destination.resolve())
