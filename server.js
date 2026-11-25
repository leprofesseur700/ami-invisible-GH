// ============================================================
// server.js : le cerveau du site "Ami invisible de prière"
// ============================================================

// On charge les outils installés avec npm install
require('dotenv').config();                 // lit le fichier .env (les secrets)
const express = require('express');         // le serveur web
const mysql = require('mysql2/promise');    // la connexion à MySQL
const bcrypt = require('bcryptjs');         // brouille les codes PIN
const jwt = require('jsonwebtoken');        // fabrique les badges de connexion
const path = require('path');               // aide à écrire des chemins de dossiers

const app = express();                      // on crée notre serveur
app.set('trust proxy', 1);                  // utile en ligne (Render) pour connaître la vraie adresse du visiteur
app.use(express.json());                    // permet au serveur de comprendre les données envoyées en JSON
app.use(express.static(path.join(__dirname, 'public'))); // le dossier "public" contiendra les pages du site

// ------------------------------------------------------------
// 1) CONNEXION À LA BASE DE DONNÉES
// ------------------------------------------------------------
const useSsl = ['true', '1', 'yes'].includes(String(process.env.DB_SSL || '').trim().toLowerCase());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  connectionLimit: 10
});

// ------------------------------------------------------------
// 0) ETAT SERVEUR
// ------------------------------------------------------------
app.get('/heath', (req, res)=>{
  res.status(200).json({status:'ok'});
})


// ------------------------------------------------------------
// 2) PETITS OUTILS
// ------------------------------------------------------------

// Enveloppe chaque route : si une erreur arrive, on répond proprement au lieu de planter
const route = (fonction) => (req, res) =>
  fonction(req, res).catch((erreur) => {
    console.error(erreur);
    res.status(500).json({ erreur: 'Erreur du serveur' });
  });

// Protection simple contre ceux qui essaient plein de codes PIN : 10 échecs max par 15 minutes
const echecs = new Map();
const FENETRE = 15 * 60 * 1000;             // 15 minutes en millisecondes
function tropDEchecs(ip) {
  const e = echecs.get(ip);
  return e && e.compte >= 10 && Date.now() - e.debut < FENETRE;
}
function noterEchec(ip) {
  const e = echecs.get(ip);
  if (!e || Date.now() - e.debut >= FENETRE) echecs.set(ip, { compte: 1, debut: Date.now() });
  else e.compte++;
}

// Fabrique le badge de connexion (valable 30 jours)
function fabriquerBadge(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Lit la ligne unique des réglages (compteur de tirages, révélation)
async function lireReglages() {
  const [lignes] = await pool.query('SELECT draw_round, revealed FROM settings WHERE id = 1');
  return lignes[0];
}

// ------------------------------------------------------------
// 3) LES GARDIENS (middlewares) : ils vérifient qui entre
// ------------------------------------------------------------

// Gardien 1 : la personne doit être connectée (avoir un badge valide)
async function exigerConnexion(req, res, next) {
  const entete = req.headers.authorization || '';
  const badge = entete.startsWith('Bearer ') ? entete.slice(7) : null;
  if (!badge) return res.status(401).json({ erreur: 'Non connecté' });
  try {
    const donnees = jwt.verify(badge, process.env.JWT_SECRET);
    const [lignes] = await pool.query(
      'SELECT id, prenom, role, last_seen_round FROM users WHERE id = ?', [donnees.id]);
    if (!lignes.length) return res.status(401).json({ erreur: 'Compte introuvable' });
    req.user = lignes[0];                   // on garde la fiche de la personne pour la suite
  } catch (e) {
    return res.status(401).json({ erreur: 'Badge invalide ou expiré' });
  }
  next();                                   // tout est bon, on laisse passer
}

// Gardien 2 : réservé au compte administrateur (toi)
function exigerAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ erreur: 'Réservé à l\'administrateur' });
  next();
}

// Gardien 3 : réservé aux comptes standard (l'admin ne participe pas)
function exigerStandard(req, res, next) {
  if (req.user.role !== 'standard') return res.status(403).json({ erreur: 'Le compte administrateur ne participe pas' });
  next();
}

// ------------------------------------------------------------
// 4) INSCRIPTION ET CONNEXION
// ------------------------------------------------------------

// Test rapide : le serveur est-il vivant ?
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Inscription : prénom + code PIN (4 à 8 chiffres)
app.post('/api/register', route(async (req, res) => {
  const prenom = String(req.body.prenom || '').trim();
  const pin = String(req.body.pin || '');
  if (prenom.length < 2 || prenom.length > 50)
    return res.status(400).json({ erreur: 'Le prénom doit faire entre 2 et 50 lettres' });
  if (!/^\d{4,8}$/.test(pin))
    return res.status(400).json({ erreur: 'Le code PIN doit contenir 4 à 8 chiffres' });

  const pinBrouille = await bcrypt.hash(pin, 10);   // on brouille le PIN avant de le ranger
  try {
    const [resultat] = await pool.query(
      'INSERT INTO users (prenom, pin_hash) VALUES (?, ?)', [prenom, pinBrouille]);
    res.json({ token: fabriquerBadge(resultat.insertId), role: 'standard' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ erreur: 'Ce prénom est déjà pris' });
    throw e;
  }
}));

// Connexion : prénom + code PIN
app.post('/api/login', route(async (req, res) => {
  if (tropDEchecs(req.ip))
    return res.status(429).json({ erreur: 'Trop d\'essais, réessaie dans 15 minutes' });
  const prenom = String(req.body.prenom || '').trim();
  const pin = String(req.body.pin || '');
  const [lignes] = await pool.query('SELECT id, pin_hash, role FROM users WHERE prenom = ?', [prenom]);
  const bon = lignes.length > 0 && await bcrypt.compare(pin, lignes[0].pin_hash);
  if (!bon) {
    noterEchec(req.ip);
    return res.status(401).json({ erreur: 'Prénom ou code PIN incorrect' });
  }
  echecs.delete(req.ip);                    // connexion réussie : on efface les échecs
  res.json({ token: fabriquerBadge(lignes[0].id), role: lignes[0].role });
}));

// Qui suis-je ? (infos de la personne connectée + état du jeu)
app.get('/api/me', exigerConnexion, route(async (req, res) => {
  const reglages = await lireReglages();
  res.json({
    prenom: req.user.prenom,
    role: req.user.role,
    tirageFait: reglages.draw_round > 0,
    revelee: !!reglages.revealed
  });
}));

// ------------------------------------------------------------
// 5) MA BOÎTE : SOUMETTRE MES SUJETS DE PRIÈRE
// ------------------------------------------------------------

// Lire mes sujets
app.get('/api/subjects', exigerConnexion, exigerStandard, route(async (req, res) => {
  const [lignes] = await pool.query(
    'SELECT id, contenu FROM prayer_subjects WHERE user_id = ? ORDER BY id', [req.user.id]);
  res.json(lignes);
}));

// Ajouter un sujet (le bouton +)
app.post('/api/subjects', exigerConnexion, exigerStandard, route(async (req, res) => {
  const contenu = String(req.body.contenu || '').trim();
  if (!contenu || contenu.length > 500)
    return res.status(400).json({ erreur: 'Le sujet doit faire entre 1 et 500 caractères' });
  const [resultat] = await pool.query(
    'INSERT INTO prayer_subjects (user_id, contenu) VALUES (?, ?)', [req.user.id, contenu]);
  res.json({ id: resultat.insertId, contenu });
}));

// Modifier un de mes sujets
app.put('/api/subjects/:id', exigerConnexion, exigerStandard, route(async (req, res) => {
  const contenu = String(req.body.contenu || '').trim();
  if (!contenu || contenu.length > 500)
    return res.status(400).json({ erreur: 'Le sujet doit faire entre 1 et 500 caractères' });
  // "AND user_id = ?" garantit qu'on ne peut modifier QUE ses propres sujets
  const [resultat] = await pool.query(
    'UPDATE prayer_subjects SET contenu = ? WHERE id = ? AND user_id = ?',
    [contenu, req.params.id, req.user.id]);
  if (resultat.affectedRows === 0) return res.status(404).json({ erreur: 'Sujet introuvable' });
  res.json({ ok: true });
}));

// Supprimer un de mes sujets
app.delete('/api/subjects/:id', exigerConnexion, exigerStandard, route(async (req, res) => {
  const [resultat] = await pool.query(
    'DELETE FROM prayer_subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (resultat.affectedRows === 0) return res.status(404).json({ erreur: 'Sujet introuvable' });
  res.json({ ok: true });
}));

// ------------------------------------------------------------
// 6) LA BOÎTE "PRIER POUR QUELQU'UN" (anonyme)
// ------------------------------------------------------------
app.get('/api/prayer', exigerConnexion, exigerStandard, route(async (req, res) => {
  const reglages = await lireReglages();
  const [tirage] = await pool.query('SELECT receiver_id FROM draws WHERE giver_id = ?', [req.user.id]);
  if (!tirage.length) return res.json({ tire: false, tirageEnCours: reglages.draw_round > 0 });

  // IMPORTANT : on envoie seulement les sujets, JAMAIS le prénom de la personne
  const [sujets] = await pool.query(
    'SELECT id, contenu FROM prayer_subjects WHERE user_id = ? ORDER BY id', [tirage[0].receiver_id]);

  // Nouveau tirage depuis la dernière visite ? Alors on avertit, puis on note que la personne l'a vu
  const nouveauTirage = req.user.last_seen_round < reglages.draw_round;
  await pool.query('UPDATE users SET last_seen_round = ? WHERE id = ?', [reglages.draw_round, req.user.id]);

  res.json({ tire: true, nouveauTirage, sujets });
}));

// ------------------------------------------------------------
// 7) LA RÉVÉLATION FINALE (la boîte-cadeau)
// ------------------------------------------------------------
app.get('/api/revelation', exigerConnexion, exigerStandard, route(async (req, res) => {
  const reglages = await lireReglages();
  if (!reglages.revealed) return res.json({ revelee: false });  // pas encore publiée

  const [priantPourMoi] = await pool.query(
    'SELECT u.prenom FROM draws d JOIN users u ON u.id = d.giver_id WHERE d.receiver_id = ?', [req.user.id]);
  const [moiPriePour] = await pool.query(
    'SELECT u.prenom FROM draws d JOIN users u ON u.id = d.receiver_id WHERE d.giver_id = ?', [req.user.id]);

  res.json({
    revelee: true,
    priaitPourMoi: priantPourMoi.length ? priantPourMoi[0].prenom : null,
    jePriaisPour: moiPriePour.length ? moiPriePour[0].prenom : null
  });
}));

// ------------------------------------------------------------
// 8) ESPACE ADMINISTRATEUR (toi seulement)
// ------------------------------------------------------------

// Voir l'état du jeu : qui est inscrit, combien de tirages, révélation faite ou non
app.get('/api/admin/etat', exigerConnexion, exigerAdmin, route(async (req, res) => {
  const reglages = await lireReglages();
  const [participants] = await pool.query(
    "SELECT id, prenom FROM users WHERE role = 'standard' ORDER BY prenom");
  const [[comptage]] = await pool.query('SELECT COUNT(*) AS n FROM draws');
  res.json({
    participants,                              // chaque participant avec son numéro et son prénom
    nombreTirages: reglages.draw_round,
    revelee: !!reglages.revealed,
    // Le tirage est "incomplet" si le nombre de lignes du tirage ne correspond plus au nombre de participants
    tirageIncomplet: reglages.draw_round > 0 && comptage.n !== participants.length
  });
}));

// Lancer (ou relancer) le tirage
app.post('/api/admin/tirage', exigerConnexion, exigerAdmin, route(async (req, res) => {
  const reglages = await lireReglages();
  if (reglages.revealed)
    return res.status(403).json({ erreur: 'La révélation est publiée : le jeu est terminé, le tirage est bloqué' });

  const [participants] = await pool.query("SELECT id FROM users WHERE role = 'standard'");
  const ids = participants.map((p) => p.id);
  if (ids.length < 2) return res.status(400).json({ erreur: 'Il faut au moins 2 participants' });

  // On mélange la liste au hasard (méthode de Fisher-Yates)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  // Chacun prie pour le suivant dans la liste mélangée, le dernier prie pour le premier.
  // Cela forme un grand cercle : personne ne se tire lui-même, et chacun est tiré une seule fois.

  const connexion = await pool.getConnection();
  try {
    await connexion.beginTransaction();       // on commence : tout réussit ou tout est annulé
    await connexion.query('DELETE FROM draws');   // on efface l'ancien tirage
    for (let i = 0; i < ids.length; i++) {
      const receveur = ids[(i + 1) % ids.length];
      await connexion.query('INSERT INTO draws (giver_id, receiver_id) VALUES (?, ?)', [ids[i], receveur]);
    }
    await connexion.query('UPDATE settings SET draw_round = draw_round + 1 WHERE id = 1');
    await connexion.commit();                 // on valide
  } catch (e) {
    await connexion.rollback();               // problème : on annule tout
    throw e;
  } finally {
    connexion.release();                      // on rend la connexion au pool
  }
  res.json({ ok: true, participants: ids.length });
}));

// Publier la révélation finale (le jeu est alors terminé)
app.post('/api/admin/revelation', exigerConnexion, exigerAdmin, route(async (req, res) => {
  const reglages = await lireReglages();
  if (reglages.draw_round === 0)
    return res.status(400).json({ erreur: 'Aucun tirage n\'a encore été fait' });
  await pool.query('UPDATE settings SET revealed = TRUE WHERE id = 1');
  res.json({ ok: true });
}));

// ------------------------------------------------------------
// SUPPRESSION DE COMPTE
// ------------------------------------------------------------

// Supprimer MON compte (il faut redonner son code PIN)
app.delete('/api/me', exigerConnexion, exigerStandard, route(async (req, res) => {
  if (tropDEchecs(req.ip))
    return res.status(429).json({ erreur: 'Trop d\'essais, réessaie dans 15 minutes' });
  const reglages = await lireReglages();
  if (reglages.revealed)
    return res.status(403).json({ erreur: 'Le jeu est terminé : les comptes ne peuvent plus être supprimés' });

  const pin = String(req.body.pin || '');
  const [lignes] = await pool.query('SELECT pin_hash FROM users WHERE id = ?', [req.user.id]);
  const bon = lignes.length > 0 && await bcrypt.compare(pin, lignes[0].pin_hash);
  if (!bon) {
    noterEchec(req.ip);
    return res.status(403).json({ erreur: 'Code PIN incorrect' });
  }
  // Les sujets et les lignes du tirage partent avec le compte (ON DELETE CASCADE)
  await pool.query('DELETE FROM users WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
}));

// L'administrateur supprime le compte d'un participant
app.delete('/api/admin/users/:id', exigerConnexion, exigerAdmin, route(async (req, res) => {
  const reglages = await lireReglages();
  if (reglages.revealed)
    return res.status(403).json({ erreur: 'Le jeu est terminé : les comptes ne peuvent plus être supprimés' });

  // "role = 'standard'" garantit qu'on ne peut jamais supprimer le compte administrateur
  const [cible] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'standard'", [req.params.id]);
  if (!cible.length) return res.status(404).json({ erreur: 'Compte introuvable' });

  const [dansTirage] = await pool.query(
    'SELECT 1 FROM draws WHERE giver_id = ? OR receiver_id = ? LIMIT 1', [req.params.id, req.params.id]);
  await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ ok: true, tirageAReFaire: dansTirage.length > 0 });
}));

// ------------------------------------------------------------
// 9) DÉMARRAGE
// ------------------------------------------------------------

async function creerAdminSiBesoin() {
  const { ADMIN_PRENOM, ADMIN_PIN } = process.env;
  if (!ADMIN_PRENOM || !ADMIN_PIN) {
    console.warn('ADMIN_PRENOM ou ADMIN_PIN manquant : aucun compte admin créé');
    return;
  }
  try {
    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    if (admins.length) return;
    const pinBrouille = await bcrypt.hash(ADMIN_PIN, 10);
    await pool.query(
      "INSERT INTO users (prenom, pin_hash, role) VALUES (?, ?, 'admin')",
      [ADMIN_PRENOM, pinBrouille]
    );
    console.log('Compte administrateur créé : ' + ADMIN_PRENOM);
  } catch (e) {
    console.error('Erreur lors de la vérification/création admin :', e.message);
  }
}

let initialisé = false;
async function initialiserApp() {
  if (initialisé) return;
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET manquant dans les variables d\'environnement');
  }
  await creerAdminSiBesoin();
  initialisé = true;
}

// Middleware d'initialisation paresseuse pour l'environnement serverless (Vercel)
app.use(async (req, res, next) => {
  try {
    await initialiserApp();
    next();
  } catch (e) {
    console.error('Erreur d\'initialisation :', e.message);
    res.status(500).json({ erreur: 'Erreur de configuration serveur' });
  }
});

// En exécution locale / serveur classique (hors Vercel), on lance app.listen
if (!process.env.VERCEL) {
  initialiserApp()
    .then(() => {
      const port = process.env.PORT || 3000;
      app.listen(port, () => console.log('Serveur démarré : http://localhost:' + port));
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = app;