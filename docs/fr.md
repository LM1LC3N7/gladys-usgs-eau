# USGS Water Data

Intégration non officielle, sans lien avec l'Institut d'études géologiques des
États-Unis (USGS). Elle lit les **dernières valeurs des stations de mesure de
l'USGS** que vous choisissez, aux États-Unis, depuis les nouvelles API Water
Data de l'USGS (`api.waterdata.usgs.gov`, domaine public) : sans compte ni clé.
Lecture seule : rien n'est jamais envoyé à l'USGS que des requêtes GET.

Essayée contre la vraie API Water Data de l'USGS le 30 octobre 2026 (six
stations : rivières, un puits à sec, un puits de nappe) ; jamais testée avec une
vraie installation Gladys pour l'instant : dites-nous ce que vous voyez.

Ce **n'est pas un système d'alerte**. La plupart des valeurs sont
**provisoires** (l'USGS peut les corriger), mesurées toutes les 15 minutes et
envoyées environ toutes les heures. Pour les crues, suivez le National Weather
Service et les autorités locales.

## Mise en route

1. Trouvez les numéros des stations : le bouton **Chercher des stations** de la
   configuration (mots du nom, par exemple `potomac dc`), ou la carte
   <https://waterdata.usgs.gov/>.
2. Saisissez-les dans **Stations** (8 à 15 chiffres, séparés par des virgules
   ou des espaces, 20 au plus). Une station d'une autre agence : son
   identifiant complet, par exemple `AR008-343826091361301`.
3. Choisissez les unités, la langue des textes, l'intervalle de lecture (15 à
   120 minutes, 15 par défaut) et l'ancienneté maximale (1 à 48 heures, 3 par
   défaut), puis enregistrez.
4. Après la première lecture, ouvrez l'onglet **Découverte** : un appareil par
   station, avec les fonctions de ce que la station a mesuré récemment. Créez
   ceux que vous voulez.

## Ce que vous obtenez

| Fonction                           | Unités américaines | Unités métriques | Paramètre USGS |
| ---------------------------------- | ------------------ | ---------------- | -------------- |
| Débit                              | pi³/s              | m³/s             | 00060, 30208   |
| Hauteur à l'échelle                | pieds              | m                | 00065          |
| Température de l'eau               | °F                 | °C               | 00010          |
| Profondeur de la nappe sous le sol | pieds              | m                | 72019          |
| État                               | texte              | texte            |                |

- Une fonction n'est proposée qu'une fois que la station en a donné une valeur
  récente. Une mesure qui apparaît plus tard (un puits qui n'est plus à sec,
  une échelle après la glace) s'ajoute à l'appareil depuis l'onglet
  Découverte : son bouton **Mettre à jour** donne la nouvelle fonction à
  l'appareil, en gardant les autres et leur historique.
- Le paramètre 30208 est le débit en m³/s que quelques stations publient à la
  place (ou à côté) du 00060 ; il remplit la même fonction. Non lus : le débit
  mesuré 00061 (aucune série en continu sur le service le 30 octobre 2026) et
  l'altitude des lacs et réservoirs (62614).
- Les conversions sont exactes (1 pied = 0,3048 m, 1 pi³/s =
  0,028316846592 m³/s, °F = °C × 9/5 + 32), puis arrondies (0,001 pour les
  pieds, les pi³/s et les mètres, 0,0001 pour les m³/s, 0,01 pour les degrés).
- L'unité fait partie de la fonction : un appareil garde les unités de sa
  création, même si le formulaire les change. Pour changer d'unités,
  supprimez l'appareil et recréez-le depuis la Découverte, ou utilisez
  **Mettre à jour** dans la Découverte : dans les deux cas les fonctions des
  anciennes unités, et leur historique, s'en vont.
- Gladys n'a pas d'unité de débit : le débit est un nombre simple, son unité
  dans son nom.
- L'**État** donne l'heure de la mesure dans le fuseau de la station
  (« Mesuré le 30 oct., 01:50 UTC−4 »), ce que l'USGS dit des valeurs publiées
  (« (estimée, provisoire) »), les mesures qui ne sont plus à jour, ou pourquoi
  il n'y a pas de valeur : « Sans valeur (à sec) », « Sans valeur (glace) »,
  « Sans valeur (sous le minimum mesurable) », « Valeur illisible à la
  source », « Aucune valeur récente ; dernière le … », « Aucune donnée en
  continu à cette station », « Station inconnue de l'USGS ». L'état de
  l'intégration dit combien de stations ont des valeurs qualifiées.
- Le fuseau d'une station vient de l'USGS (son abréviation). Son indicateur
  d'heure d'été est faux pour beaucoup de stations (la plupart de la Floride
  dit « pas d'heure d'été ») : il ne sert qu'à distinguer l'Arizona du reste
  du fuseau des Rocheuses ; toute autre station suit l'heure d'été de son
  fuseau. Les Samoa américaines (`ZP-11`) ont leur propre heure ; un fuseau
  inconnu, UTC.

## Fraîcheur

- Chaque mesure est publiée **une seule fois** (dédoublonnée sur son heure,
  gardée dans /data), sans date de création : une scène « hauteur au-dessus de
  X » se déclenche sur une nouvelle mesure, pas à chaque lecture. Le point de
  l'historique de Gladys est daté de sa publication, pas de la mesure : plus
  tard du délai de transmission de la station plus un intervalle de lecture au
  plus (au plus l'ancienneté maximale). Le SDK peut dater un état, mais un état
  daté ne déclenche pas de scène.
- Une mesure plus ancienne que l'**ancienneté maximale** du formulaire n'est
  pas récente : elle n'est pas publiée, l'état dit quand elle a été mesurée.
  L'âge est compté depuis l'en-tête `Date` de la réponse de l'USGS (depuis notre
  horloge quand cet en-tête manque ou s'en écarte de plus d'un jour), plus le
  temps écoulé depuis la lecture.
- Une valeur datée de plus de 15 minutes dans le futur, une valeur qui n'est
  pas un nombre simple (un texte, une valeur vide), hors de la plage plausible
  de sa mesure (par exemple un « -999999 ») ou dans une unité inconnue est
  illisible : jamais publiée.
- **Qualificatifs.** L'USGS envoie des codes avec une valeur. Ceux qui ne
  font que la nuancer (`ESTIMATED`, `REVISED`, `BACKWATER`, `REGULATED`,
  `DEBRIS`, `DIFFDATUM`, `RATINGDEV`, `TIDE`, `URBAN`, `OTHERAGENCY`,
  `OPPORTUNISTIC`, `FORCEINTERPOLATION`) : la valeur est publiée, l'état dit le
  code. Tout autre code (`DRY`, `ICE`, `EQUIP`, `MAINT`, `UNAVAIL`, `TEST`,
  `DISCONTINUED`, `SEASONAL`, `FLOOD`, `DAMFAILURE`, `ZEROFLOW`, `LESSTHAN`,
  `GREATERTHAN`, `BLWMIN`, `GHNOTASSCPKQ`, et tout code absent de ces listes)
  signifie que le nombre n'est pas une mesure de l'eau : il n'est pas publié,
  même quand l'USGS en donne un (le nombre d'un puits à sec est la profondeur
  de son capteur ; le `0.00` d'une échelle à sec ou à débit nul n'est pas
  publié non plus ; « inférieur à » est une borne), et l'état donne la raison.
  La liste est celle que le vrai service envoyait le 30 octobre 2026.
- La plupart des valeurs sont provisoires (pas encore approuvées par
  l'USGS) : l'état dit « provisoire ».
- Une station avec plusieurs séries d'une même mesure (deux capteurs, une série
  arrêtée en 2019) : parmi les séries récentes, celle du plus petit identifiant
  (la même d'une lecture à l'autre tant qu'elle reste récente).
- Gladys garde la dernière valeur publiée : quand une valeur n'est plus
  récente, l'**État** le dit ; la valeur affichée garde sa propre date dans
  Gladys.
- Les textes d'état suivent les âges à chaque lecture, et à chaque intervalle
  pendant une longue pause.

## Seuils de crue et scènes

L'API de l'USGS ne donne pas de seuil de crue (les catégories de crue sont
celles du National Weather Service). Utilisez les seuils connus pour votre
rivière dans une scène : le déclencheur **Changement d'état d'un appareil** sur
la hauteur ou le débit, avec la condition « supérieur à X ». Il se déclenche à
la première mesure récente au-dessus de X.

## Rythme et requêtes

- **Une requête pour toutes les stations** à chaque lecture
  (`latest-continuous`), suivie de 2 pages de plus au plus si la réponse en
  annonce (jamais une autre adresse), puis, une fois par semaine, une requête
  pour les noms et fuseaux des stations (`monitoring-locations`). Une requête
  à la fois, bouton de recherche compris.
- Une lecture par intervalle, quoi qui la demande : enregistrer le formulaire
  inchangé, une reconnexion, l'onglet Découverte, un appareil créé ou un
  redémarrage ne lisent rien plus tôt (l'heure de la lecture est écrite dans
  /data avant la requête). Exceptions :
  - le premier démarrage (pas encore de fichier /data) lit tout de suite ;
  - une **nouvelle liste de stations** est lue une minute après la dernière
    lecture au plus tôt ;
  - une lecture coupée avant ses valeurs (formulaire enregistré, reconnexion)
    est refaite une minute après elle ;
  - quand /data ne peut pas être lu, ou contient une date invalide ou dans le
    futur, la première lecture vient un intervalle après le démarrage ;
  - un intervalle raccourci dans le formulaire rapproche la lecture suivante
    (le nouvel intervalle après la dernière lecture).
- Chaque requête est bornée : 20 secondes, 2 Mo pour une page de valeurs,
  512 Ko pour les noms ou une recherche.
- User-Agent : `gladys-usgs-eau/<version> (+adresse du dépôt)` ; `Accept`
  `application/geo+json`. L'USGS répond `no-cache` sans ETag ni Last-Modified :
  pas de requête conditionnelle.
- **429** (trop de requêtes) : toutes les requêtes à l'USGS sont mises en pause,
  5 minutes doublées à chaque nouvelle, `Retry-After` respecté, entre 60
  secondes et 6 heures, gardée après un redémarrage ; la lecture suivante vient
  à la fin de la pause, pas un tour plus tard. Un **5xx** des valeurs met les
  lectures en pause de la même façon ; un 5xx des noms ou d'une recherche ne
  met rien en pause.
- Un échec des noms et fuseaux n'arrête jamais les valeurs (un 429 est la
  limite du service entier : il met toutes les requêtes en pause, comme plus
  haut) : le numéro de la station sert alors de nom, les heures sont en UTC,
  ils sont redemandés une heure plus tard.
- Gladys accepte 300 états par minute : le module en envoie 250 au plus sur
  une minute glissante ; au-delà, le reste passe en premier à la lecture
  suivante, à tour de rôle.

## Chercher des stations

Le bouton demande à l'USGS les stations dont le nom contient chaque mot tapé
(lettres et chiffres seulement, 2 à 30 caractères, 4 mots au plus) et en liste
15 avec le numéro à copier. Une recherche toutes les 10 secondes au plus,
aucune pendant une pause ; une recherche qui attend plus de 45 secondes
derrière une lecture abandonne.

## État de l'intégration

« Connecté » seulement quand la dernière lecture a réussi **et** qu'au moins une
station a une valeur récente. Sinon le message dit pourquoi : l'USGS répond
mais aucune station n'a de valeur récente, la dernière lecture a échoué
(réseau, pas de réponse à temps, refus, réponse trop grande, incomplète ou
inattendue), en pause jusqu'à une heure (UTC) ; et aussi des stations saisies
qui ne sont pas des numéros, une valeur du formulaire remplacée, des stations
inconnues de l'USGS, les noms non lus, /data illisible (mis de côté sous un
autre nom) ou non inscriptible, des valeurs reportées à la lecture suivante.
Avant la première lecture : « En attente de la première lecture ».

## Données et licence

- Données de l'USGS, dans le domaine public. La plupart des valeurs en temps
  réel sont provisoires.
- Aucune donnée personnelle n'est lue ni gardée. /data garde l'heure de la
  dernière lecture, la pause, les noms, fuseaux et mesures des stations, et
  l'heure de la dernière mesure publiée par fonction.
