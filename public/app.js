// ===== app.js : la partie qui s'exécute dans le navigateur de chaque ami =====

// Le badge de connexion est gardé dans le navigateur sous ce nom
const CLE_BADGE = 'ami_badge';
let badge = localStorage.getItem(CLE_BADGE); // on récupère le badge s'il existe déjà
let minuteur = null;                          // servira à rafraîchir la boîte de prière

// Raccourci : trouver un élément de la page grâce à son id
const $ = (id) => document.getElementById(id);

// ---------- Parler au serveur ----------
async function api(chemin, methode = 'GET', corps) {
  const options = { method: methode, headers: {} };
  if (badge) options.headers['Authorization'] = 'Bearer ' + badge; // on montre le badge
  if (corps) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(corps);                          // on envoie les données
  }
  const reponse = await fetch('/api/' + chemin, options);          // on appelle le serveur
  const donnees = await reponse.json().catch(() => ({}));
  if (reponse.status === 401 && badge) quitter();                  // badge périmé : retour à la connexion
  if (!reponse.ok) throw new Error(donnees.erreur || 'Une erreur est survenue');
  return donnees;
}

// ---------- Changer d'écran ----------
const VUES = ['vue-connexion', 'vue-accueil', 'vue-sujets', 'vue-priere', 'vue-cadeau', 'vue-admin'];
function afficher(idVue) {
  clearInterval(minuteur);                                  // on arrête le rafraîchissement automatique
  VUES.forEach((v) => $(v).classList.toggle('actif', v === idVue)); // seul l'écran voulu est visible
  $('entete').classList.toggle('cache', idVue === 'vue-connexion');
}

// ---------- Connexion / inscription ----------
async function envoyerConnexion(mode) {          // mode vaut 'login' ou 'register'
  $('erreurConnexion').textContent = '';
  try {
    const r = await api(mode, 'POST', { prenom: $('prenom').value, pin: $('pin').value });
    badge = r.token;
    localStorage.setItem(CLE_BADGE, badge);      // on garde le badge dans le navigateur
    $('pin').value = '';
    await ouvrirAccueil();
  } catch (e) {
    $('erreurConnexion').textContent = e.message;
  }
}
$('btnConnexion').addEventListener('click', () => envoyerConnexion('login'));
$('btnInscription').addEventListener('click', () => envoyerConnexion('register'));

function quitter() {
  badge = null;
  localStorage.removeItem(CLE_BADGE);
  afficher('vue-connexion');
}
$('btnQuitter').addEventListener('click', quitter);

// ---------- Accueil ----------
async function ouvrirAccueil() {
  const moi = await api('me');
  $('salut').textContent = 'Bonjour ' + moi.prenom;
  if (moi.role === 'admin') return ouvrirAdmin();            // l'admin va dans son espace
  $('carteCadeau').classList.toggle('cache', !moi.revelee);  // la carte cadeau n'apparaît qu'après la révélation
  afficher('vue-accueil');
}
// Tous les boutons "Retour" ramènent à l'accueil
document.querySelectorAll('.retour').forEach((b) => b.addEventListener('click', ouvrirAccueil));

// ---------- Mes sujets de prière ----------
function numeroter() {                            // écrit "Sujet 1", "Sujet 2"... dans l'ordre
  document.querySelectorAll('#listeSujets .etiquette').forEach((e, i) => {
    e.textContent = 'Sujet ' + (i + 1);
  });
}

function ajouterLigne(id, texte) {
  const ligne = document.createElement('div');
  ligne.className = 'ligne';
  ligne.dataset.id = id || '';                    // numéro du sujet (vide tant qu'il n'est pas enregistré)

  const etiquette = document.createElement('div');
  etiquette.className = 'etiquette';

  const champ = document.createElement('textarea');
  champ.rows = 2;
  champ.maxLength = 500;
  champ.placeholder = 'Écris ton sujet de prière ici';
  champ.value = texte || '';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const btnOk = document.createElement('button');
  btnOk.textContent = '✓ Valider';
  const btnSup = document.createElement('button');
  btnSup.textContent = '✕ Supprimer';
  btnSup.className = 'danger';
  actions.append(btnOk, btnSup);

  btnOk.addEventListener('click', async () => {
    const contenu = champ.value.trim();
    if (!contenu) { $('messageSujets').textContent = 'Écris quelque chose avant de valider.'; return; }
    try {
      if (ligne.dataset.id) {
        await api('subjects/' + ligne.dataset.id, 'PUT', { contenu });      // modifier
      } else {
        const r = await api('subjects', 'POST', { contenu });               // créer
        ligne.dataset.id = r.id;
      }
      $('messageSujets').textContent = 'Enregistré ✓';
    } catch (e) { $('messageSujets').textContent = e.message; }
  });

  btnSup.addEventListener('click', async () => {
    try {
      if (ligne.dataset.id) {
        if (!confirm('Supprimer ce sujet ?')) return;
        await api('subjects/' + ligne.dataset.id, 'DELETE');
      }
      ligne.remove();
      numeroter();
    } catch (e) { $('messageSujets').textContent = e.message; }
  });

  ligne.append(etiquette, champ, actions);
  $('listeSujets').append(ligne);
  numeroter();
  return champ;
}

async function ouvrirSujets() {
  afficher('vue-sujets');
  $('messageSujets').textContent = '';
  $('listeSujets').replaceChildren();             // on vide la liste avant de la remplir
  try {
    const sujets = await api('subjects');
    sujets.forEach((s) => ajouterLigne(s.id, s.contenu));
  } catch (e) { $('messageSujets').textContent = e.message; }
}
$('carteSujets').addEventListener('click', ouvrirSujets);
$('btnPlus').addEventListener('click', () => ajouterLigne(null, '').focus());

// ---------- Prier pour quelqu'un ----------
async function chargerPriere() {
  try {
    const r = await api('prayer');
    if (!r.tire) {
      $('messagePriere').textContent = "Le tirage n'a pas encore eu lieu. Reviens bientôt !";
      $('listePriere').replaceChildren();
      return;
    }
    if (r.nouveauTirage) $('bandeau').classList.remove('cache');
    $('messagePriere').textContent = r.sujets.length
      ? 'Voici les sujets de la personne pour qui tu pries :'
      : "La personne pour qui tu pries n'a pas encore ajouté de sujet.";
    const lignes = r.sujets.map((s) => {
      const li = document.createElement('li');
      li.textContent = s.contenu;                 // textContent : sécurité, le texte ne peut pas devenir du code
      return li;
    });
    $('listePriere').replaceChildren(...lignes);
  } catch (e) { $('messagePriere').textContent = e.message; }
}

async function ouvrirPriere() {
  afficher('vue-priere');
  $('bandeau').classList.add('cache');
  await chargerPriere();
  minuteur = setInterval(chargerPriere, 15000);   // on remet à jour toutes les 15 secondes
}
$('cartePriere').addEventListener('click', ouvrirPriere);

// ---------- La boîte-cadeau (révélation) ----------
function ouvrirCadeau() {
  afficher('vue-cadeau');
  $('boiteCadeau').classList.remove('ouvert');
  $('resultatCadeau').classList.add('cache');
  $('invite').classList.remove('cache');
  $('invite').textContent = 'Clique sur la boîte pour découvrir ta surprise 🎁';
}
$('carteCadeau').addEventListener('click', ouvrirCadeau);

$('boiteCadeau').addEventListener('click', async () => {
  try {
    const r = await api('revelation');
    if (!r.revelee) { $('invite').textContent = "La révélation n'est pas encore publiée."; return; }
    $('qui1').textContent = r.priaitPourMoi || 'personne';
    $('qui2').textContent = r.jePriaisPour || 'personne';
    $('boiteCadeau').classList.add('ouvert');
    $('invite').classList.add('cache');
    $('resultatCadeau').classList.remove('cache');
  } catch (e) { $('invite').textContent = e.message; }
});

// ---------- Espace administrateur ----------
async function ouvrirAdmin() {
  afficher('vue-admin');
  const e = await api('admin/etat');
  $('adminInfo').textContent = e.participants.length + ' participant(s) · tirages lancés : ' +
    e.nombreTirages + (e.revelee ? ' · révélation publiée' : '');
  const lignes = e.participants.map((p) => {
    const li = document.createElement('li');
    li.textContent = p;
    return li;
  });
  $('listeParticipants').replaceChildren(...lignes);
  $('btnTirage').disabled = e.revelee;                          // tirage bloqué après la révélation
  $('btnRevelation').disabled = e.revelee || e.nombreTirages === 0;
}

$('btnTirage').addEventListener('click', async () => {
  if (!confirm('Lancer le tirage ? Il remplacera le précédent.')) return;
  try {
    await api('admin/tirage', 'POST');
    await ouvrirAdmin();
    $('adminMessage').textContent = 'Tirage effectué ✓';
  } catch (e) { $('adminMessage').textContent = e.message; }
});

$('btnRevelation').addEventListener('click', async () => {
  if (!confirm('Publier la révélation ? Le jeu sera terminé et le tirage bloqué définitivement.')) return;
  try {
    await api('admin/revelation', 'POST');
    await ouvrirAdmin();
    $('adminMessage').textContent = 'Révélation publiée ✓';
  } catch (e) { $('adminMessage').textContent = e.message; }
});

// ---------- Démarrage de la page ----------
(async function demarrer() {
  if (badge) {
    try { await ouvrirAccueil(); return; } catch (e) { /* badge invalide : on continue */ }
  }
  afficher('vue-connexion');
})();