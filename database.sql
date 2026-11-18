-- On efface l'ancienne version de la base (si elle existe) pour repartir propre
DROP DATABASE IF EXISTS ami_invisible_priere;

-- On crée la base (le grand classeur)
CREATE DATABASE ami_invisible_priere
  CHARACTER SET utf8mb4          -- accepte les accents et les emojis
  COLLATE utf8mb4_unicode_ci;    -- "a" et "A" sont traités pareil

-- On entre dans ce classeur
USE ami_invisible_priere;

-- TABLE 1 : les comptes (une fiche par personne)
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,   -- numéro de la fiche, automatique
  prenom VARCHAR(50) NOT NULL UNIQUE,  -- le prénom, obligatoire, pas de doublon
  pin_hash VARCHAR(255) NOT NULL,      -- le code PIN brouillé (jamais en clair)
  role ENUM('standard','admin') NOT NULL DEFAULT 'standard', -- type de compte : standard (participe) ou admin (toi, ne participe pas)
  last_seen_round INT NOT NULL DEFAULT 0, -- dernier tirage que cette personne a vu (sert à l'avertir d'un nouveau tirage)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- date d'inscription, automatique
);

-- TABLE 2 : les sujets de prière
CREATE TABLE prayer_subjects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,                -- le numéro du propriétaire du sujet
  contenu TEXT NOT NULL,               -- le texte du sujet
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- TABLE 3 : le tirage (qui prie pour qui)
CREATE TABLE draws (
  giver_id INT NOT NULL UNIQUE,        -- celui qui prie
  receiver_id INT NOT NULL UNIQUE,     -- celui pour qui on prie
  FOREIGN KEY (giver_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

-- TABLE 4 : l'état général du jeu (une seule ligne)
CREATE TABLE settings (
  id INT PRIMARY KEY,                           -- toujours 1
  draw_round INT NOT NULL DEFAULT 0,            -- compteur : +1 à chaque tirage lancé
  revealed BOOLEAN NOT NULL DEFAULT FALSE       -- la révélation finale est-elle publiée ? (non au départ)
);

-- On crée l'unique ligne de réglages
INSERT INTO settings (id) VALUES (1);