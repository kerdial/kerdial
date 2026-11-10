# Formats d'export et d'import Kerdial

Kerdial exporte vos données dans **deux fichiers**, et sait les relire. Ce document décrit les deux
formats assez précisément pour que vous puissiez en écrire un à la main, dans un tableur, sans
jamais avoir exporté quoi que ce soit.

Il est destiné à la personne qui utilise Kerdial, pas à un développeur : les noms de colonnes et les
codes sont donnés tels qu'ils apparaissent dans le fichier — en anglais, parce que ce sont les mêmes
codes que l'application utilise partout ailleurs — chacun accompagné de sa traduction.

## 1. À quoi servent ces deux fichiers

L'écran **« Importer »** propose deux exports :

| Fichier | Bouton | Contenu |
| --- | --- | --- |
| `kerdial-instruments.json` | « Exporter le catalogue (JSON) » | Les titres et leur classification, leurs icônes, les cours que vous avez saisis à la main, votre liste de suivi, vos portefeuilles et leurs comptes espèces, et les taux de change que vous avez fixés vous-même. |
| `kerdial-transactions.csv` | « Exporter les opérations (CSV) » | Toutes vos opérations : achats, ventes, dépôts, retraits, dividendes, réinvestissements, conversions de devises, attributions d'actions. |

Les deux fichiers sont **indépendants**. Vous pouvez en importer un sans l'autre, et dans l'ordre que
vous voulez — avec une réserve, expliquée en section 7 : une opération ne peut être écrite que si le
titre qu'elle nomme existe déjà.

Ensemble, ils sont une **sauvegarde complète de ce que vous avez saisi**. Restaurés dans une
installation vide, ils reconstruisent vos portefeuilles, vos comptes, vos titres et votre historique.
Tout le reste — cours de bourse, cotations, taux de change des fournisseurs de données — est
retéléchargé ensuite (section 2).

Le fichier de catalogue contient **tout le catalogue de titres visible depuis votre installation**,
et pas seulement les titres que vous détenez : c'est exactement ce que liste l'écran « Instruments ».
Un titre que vous avez créé pour le surveiller plus tard, sans encore avoir passé d'opération
dessus, fait donc partie de votre sauvegarde. Les éléments qui vous appartiennent — icône, cours
saisis, ligne de suivi — ne sont attachés qu'aux titres pour lesquels vous les avez renseignés.

## 2. Ce que les fichiers ne contiennent pas

Volontairement absents :

- **les cours de bourse, les cotations et les taux de change des fournisseurs de données.** Ce sont
  des données publiques que l'application sait retélécharger ; les embarquer rendrait le fichier
  énorme et le figerait à la date de l'export. Après un import, Kerdial relance ses propres
  téléchargements et les valorisations sont recalculées. C'est pourquoi un portefeuille restauré
  peut rester sans valorisation pendant quelques minutes ;
- **vos identifiants** — adresse e-mail, mot de passe, sessions ouvertes. Un fichier d'export ne
  permet de se connecter nulle part ;
- **le journal de modification des opérations** (qui a modifié quoi, et quand). Il documente
  l'historique d'une installation donnée, pas votre patrimoine ;
- **tout ce que l'application calcule** : soldes, positions, plus-values, valorisations
  quotidiennes. Ce sont des résultats, pas des saisies ; ils sont reconstruits à partir des
  opérations, et les embarquer permettrait à un fichier de contredire ses propres lignes ;
- **les identifiants techniques internes** des lignes. Un import les régénère. Les renvois à
  l'intérieur d'un fichier se font par **nom** (un portefeuille) ou par **identité de titre** (ISIN,
  place de cotation, symbole), jamais par identifiant interne.

Ce que vous avez saisi à la main est, lui, intégralement exporté : les cours saisis manuellement, les
taux de change que vous avez fixés, les notes, les références, les icônes que vous avez téléversées.

## 3. Le dialecte du CSV

Le fichier d'opérations est un CSV au sens de la RFC 4180. La colonne de gauche indique ce que
Kerdial **écrit**, celle de droite ce qu'il **accepte de relire** — la seconde est plus large que la
première, parce qu'un fichier écrit dans un tableur ne ressemble jamais tout à fait à un fichier
écrit par un programme.

| Règle | À l'écriture | À la lecture |
| --- | --- | --- |
| Encodage | UTF-8, sans BOM | UTF-8. Un BOM en tête de fichier est toléré et ignoré |
| Fin de ligne | `CRLF` | `CRLF` ou `LF`, au choix. La dernière ligne peut être terminée ou non |
| Séparateur de colonnes | la virgule `,` | la virgule `,` **ou** le point-virgule `;`. Le séparateur est déterminé une fois, sur la ligne d'en-tête, et vaut pour tout le fichier |
| Séparateur décimal | le point : `1234.56` | le point `.` toujours ; **et la virgule** `1234,56` lorsque le séparateur de colonnes est le point-virgule — c'est le réglage d'un tableur francophone |
| Séparateur de milliers | jamais écrit | **refusé.** `1 234,56`, `1 234.56`, `1'234.56` sont des valeurs invalides. C'est ce qui rend la règle précédente sans ambiguïté : avec le point-virgule, une virgule ne peut être qu'une marque décimale |
| Guillemets | un champ est entouré de `"` s'il contient le séparateur, un guillemet ou un retour à la ligne ; un guillemet interne est doublé (`""`) | idem |
| Champ vide | rien entre deux séparateurs | rien, ou `""` : les deux signifient « valeur absente » |
| Ligne de version | première ligne `# kerdial-transactions v2` | **facultative.** Absente, la version courante est supposée — un fichier écrit à la main n'a pas à commencer par une ligne d'en-tête technique. Présente avec un numéro inconnu, le fichier est refusé en entier |
| En-tête | toutes les colonnes, dans l'ordre du tableau de la section 5 | la première ligne qui ne commence pas par `#`. **L'ordre des colonnes est libre.** Une colonne inconnue fait refuser le fichier en nommant la colonne fautive, plutôt que d'être ignorée en silence — une faute de frappe est ainsi visible |
| Ligne mal formée | — | une ligne dont le nombre de champs ne correspond pas à l'en-tête est **rejetée seule**, avec son numéro de ligne ; le reste du fichier est importé |

Un `#` en début de **ligne de données** n'est pas un commentaire : seules les lignes situées avant
l'en-tête sont inspectées. Une note commençant par `#` est donc sans danger.

## 4. Les colonnes obligatoires, et le fichier minimal

Les douze colonnes ci-dessous sont celles qu'une opération ne peut pas ne pas avoir. Elles se lisent
en deux temps :

- **obligatoire dans l'en-tête** (noté `R` ci-dessous) : la colonne doit exister, sinon le fichier
  est refusé avant même la première ligne ;
- **obligatoire selon la ligne** (noté `R*`) : la colonne peut manquer de l'en-tête — un fichier qui
  ne contient que des dépôts n'a aucune colonne de titre — mais elle doit être renseignée sur les
  lignes qui en ont besoin.

| Colonne | Signification | Niveau | Type | S'applique à | Exemple |
| --- | --- | --- | --- | --- | --- |
| `date` | date de l'opération | R | `AAAA-MM-JJ` | toutes | `2026-01-06` |
| `type` | nature de l'opération | R | code (ci-dessous) | toutes | `BUY` |
| `portfolio` | nom du portefeuille | R | texte | toutes | `Portefeuille` |
| `cash_account` | nom du compte espèces | R | texte | toutes sauf `SHARE_DISTRIBUTION`, `TRANSFER_OUT`, `TRANSFER_IN` | `Compte principal` |
| `cash_account_currency` | devise de ce compte espèces | R | code ISO 4217 | avec `cash_account` | `EUR` |
| `currency` | devise de l'opération | R | code ISO 4217 | toutes | `EUR` |
| `isin` | code ISIN du titre | R\* | 12 caractères | `BUY`, `SELL`, `DIVIDEND`, `DRIP`, `SHARE_DISTRIBUTION`, `TRANSFER_OUT`, `TRANSFER_IN` ; facultatif pour `FEE` | `FR0000120073` |
| `exchange_mic` | place de cotation | R\* | code ISO 10383, 4 caractères | idem | `XPAR` |
| `symbol` | symbole boursier | R\* | texte | idem | `AI` |
| `quantity` | nombre de titres | R\* | décimal | `BUY`, `SELL`, `DRIP`, `SHARE_DISTRIBUTION`, `TRANSFER_OUT`, `TRANSFER_IN` | `10` |
| `unit_price` | prix unitaire | R\* | décimal | `BUY`, `SELL`, `DRIP` | `100.00` |
| `gross_amount` | montant brut (pour un transfert : la valeur de marché des titres transférés) | R\* | décimal `> 0` | `BUY`, `SELL`, `DEPOSIT`, `WITHDRAWAL`, `DIVIDEND`, `CURRENCY_EXCHANGE`, `SHARE_DISTRIBUTION`, `TRANSFER_OUT`, `TRANSFER_IN`, `INTEREST`, `FEE` | `10000.00` |

L'identité d'un titre s'écrit soit **`isin` + `exchange_mic`**, soit **`symbol`** seul pour une
crypto-monnaie ou un indice. Les deux peuvent coexister : le symbole sert alors à lever une
ambiguïté.

### Les valeurs de `type`

| Code | Opération |
| --- | --- |
| `BUY` | achat |
| `SELL` | vente |
| `DEPOSIT` | dépôt d'espèces |
| `WITHDRAWAL` | retrait d'espèces |
| `DIVIDEND` | dividende |
| `DRIP` | dividende réinvesti en titres |
| `CURRENCY_EXCHANGE` | conversion de devise |
| `SHARE_DISTRIBUTION` | attribution d'actions (sans mouvement d'espèces) |
| `TRANSFER_OUT` | transfert de titres sortant d'un portefeuille (sans mouvement d'espèces) |
| `TRANSFER_IN` | transfert de titres entrant dans un portefeuille (sans mouvement d'espèces) |
| `INTEREST` | intérêts perçus sur des liquidités (retenue à la source facultative) |
| `FEE` | frais de portefeuille (garde, tenue de compte, intérêts débiteurs…), débités d'un compte d'espèces ; titre concerné facultatif |

### Le fichier minimal, en entier

Voici un fichier complet et valide qui n'utilise que ces douze colonnes. Il est **repris tel quel**
du fichier de test `importer/src/__fixtures__/kerdial-csv/minimal-tier.csv` : ce n'est pas une
illustration écrite pour ce document, c'est le fichier que la suite de tests importe réellement, et
un test compare le bloc ci-dessous à ce fichier caractère par caractère.

```csv
# kerdial-transactions v2
date,type,portfolio,cash_account,cash_account_currency,isin,exchange_mic,symbol,quantity,unit_price,gross_amount,currency
2026-01-05,DEPOSIT,Portefeuille,Compte principal,EUR,,,,,,10000.00,EUR
2026-01-06,BUY,Portefeuille,Compte principal,EUR,FRKERDEI7001,XPAR,,10,100.00,,EUR
2026-01-07,BUY,Portefeuille,Compte principal,EUR,FRKERDEI7001,XPAR,,10,120.00,,EUR
2026-02-10,DIVIDEND,Portefeuille,Compte principal,EUR,FRKERDEI7001,XPAR,,,,45.00,EUR
2026-03-11,SELL,Portefeuille,Compte principal,EUR,FRKERDEI7001,XPAR,,5,130.00,,EUR
2026-03-12,BUY,Portefeuille,Compte principal,EUR,FRKERDEI7002,XPAR,,4,250.00,,EUR
2026-04-01,WITHDRAWAL,Portefeuille,Compte principal,EUR,,,,,,500.00,EUR
```

Sept lignes, deux titres, un portefeuille, un compte espèces. Ce qu'il faut en retenir :

- une cellule vide est une valeur absente : un dépôt ne nomme pas de titre, un achat n'a pas de
  montant brut (il est déduit de la quantité et du prix unitaire) ;
- le portefeuille et le compte espèces sont désignés par leur **nom**. S'ils n'existent pas, ils sont
  créés (section 7) ;
- les deux titres, eux, doivent exister avant l'import — voir la section 7.

## 5. Les colonnes optionnelles

Ces colonnes peuvent être absentes de l'en-tête, ou présentes et vides sur une ligne : c'est la même
chose. Une colonne renseignée sur une ligne dont le type ne l'admet pas fait rejeter cette ligne —
pas le fichier.

| Colonne | Signification | Type | S'applique à | Exemple |
| --- | --- | --- | --- | --- |
| `time` | heure de l'opération, lue en heure de Paris | `HH:MM` ou `HH:MM:SS` | toutes | `09:31` |
| `reference` | votre référence d'opération (120 caractères) | texte | toutes | `AV-2026-114` |
| `note` | note libre (2 000 caractères) | texte | toutes | `Renforcement` |
| `fx_rate` | taux de change que **vous** fixez pour cette ligne | décimal | toutes | `1.0824` |
| `import_fingerprint` | l'empreinte d'origine de la ligne (section 7) | texte | toutes | `kd1:3f8c…` |
| `fee_amount` | total des frais | décimal | `BUY`, `SELL`, `DRIP`, `CURRENCY_EXCHANGE` | `2.50` |
| `broker_fee` | dont courtage | décimal | idem | `1.50` |
| `fx_fee` | dont frais de change | décimal | idem | `0.40` |
| `trade_tax` | dont taxe sur la transaction | décimal | idem | `0.30` |
| `other_cost` | dont autres frais | décimal | idem | `0.30` |
| `cash_currency` | devise du compte espèces, si elle diffère de `currency` | code ISO 4217 | `BUY`, `SELL`, `DIVIDEND`, `DRIP`, `INTEREST`, `FEE` | `USD` |
| `cash_amount` | montant réellement débité ou crédité dans cette devise | décimal | idem | `1082.40` |
| `withholding_amount` | retenue à la source, dans la devise du compte espèces de la ligne ; elle est déduite du montant crédité sur ce même compte | décimal | `DIVIDEND`, `INTEREST` | `6.75` |
| `row_ref` | étiquette libre de cette ligne (32 caractères), interne au fichier | texte | `DIVIDEND`, `TRANSFER_OUT` | `div-2026-04` |
| `drip_of` | `row_ref` du dividende que ce réinvestissement emploie | texte | `DRIP` | `div-2026-04` |
| `transfer_of` | `row_ref` du transfert sortant dont cette ligne est l'arrivée | texte | `TRANSFER_IN` | `t1` |
| `transfer_cost_base` | coût d'acquisition apporté par les titres reçus, en devise de référence | décimal `>= 0` | `TRANSFER_IN` | `660.00` |
| `transfer_cost_native` | le même coût, dans sa propre devise | décimal `>= 0` | `TRANSFER_IN` | `660.00` |
| `transfer_cost_currency` | devise de `transfer_cost_native` | code ISO 4217 | `TRANSFER_IN` | `EUR` |
| `target_currency` | devise obtenue | code ISO 4217 | `CURRENCY_EXCHANGE` | `USD` |
| `exchange_rate` | cours appliqué, en `target_currency` par unité de `currency` | décimal | `CURRENCY_EXCHANGE` | `1.0824` |
| `target_amount` | montant obtenu | décimal | `CURRENCY_EXCHANGE` | `1082.40` |
| `target_cash_account` | compte espèces crédité, dont la devise doit être `target_currency` | nom d'un compte du même portefeuille | `CURRENCY_EXCHANGE` | `Compte USD` |
| `settlement_isin` | titre remis en paiement | 12 caractères | `BUY` | `FR0000120073` |
| `settlement_exchange_mic` | sa place de cotation | code ISO 10383 | `BUY` | `XPAR` |
| `settlement_symbol` | son symbole | texte | `BUY` | `AI` |
| `settlement_amount` | quantité de ce titre remise | décimal | `BUY` | `3` |

Trois précisions qui évitent un rejet inutile :

- **`fee_amount` et ses quatre composantes.** Vous pouvez ne renseigner que le total, ou seulement
  les composantes — le total est alors la somme. Renseigner les deux avec des valeurs
  contradictoires fait rejeter la ligne.
- **`exchange_rate` et `target_amount`.** C'est le **cours** qui est écrit ; le montant obtenu est
  vérifié contre lui. S'ils se contredisent, la ligne est rejetée plutôt qu'arbitrée.
- **`fx_rate` n'est écrit à l'export que si vous avez fixé le taux vous-même.**
  Un taux obtenu d'un fournisseur de données n'est pas exporté : il sera retéléchargé (section 2).
  Un taux que vous fournissez dans un fichier est, lui, enregistré comme fixé par vous et n'est
  jamais recalculé.

**Les transferts de titres entre deux portefeuilles** s'écrivent en deux lignes : le départ
(`TRANSFER_OUT`), dans le portefeuille d'origine, porte une étiquette `row_ref` ; l'arrivée
(`TRANSFER_IN`), dans le portefeuille de destination, reprend cette étiquette dans `transfer_of`. Les
deux lignes doivent concorder — même titre, même date, même quantité, même valeur, même devise, et
deux portefeuilles différents — sinon elles sont rejetées toutes les deux, jamais une seule. À
l'import, c'est le départ qui enregistre les deux jambes : l'arrivée est signalée « déjà enregistrée
par le transfert sortant », et son coût (`transfer_cost_*`) est recalculé à partir de l'historique du
portefeuille d'origine plutôt que lu dans le fichier. Deux cas particuliers :

- un **départ sans destination** (des titres sortis de l'application) n'a pas d'étiquette et se
  réimporte seul ;
- une **arrivée sans départ** — son portefeuille d'origine a été supprimé depuis — n'a pas de
  `transfer_of` ; elle se réimporte seule, et ses trois colonnes `transfer_cost_*` sont alors
  **obligatoires**, puisque rien d'autre ne permet de retrouver ce coût.

Un fichier qui contient au moins un transfert entre deux de ses portefeuilles est écrit dans l'ordre
chronologique de ses lignes, tous portefeuilles confondus, plutôt que portefeuille par portefeuille :
c'est ce qui permet à un aller-retour entre deux portefeuilles de se réimporter. Un tel fichier
s'écrit en lots plus courts, donc plus lentement : un gros fichier de ce genre demande nettement plus de
reprises qu'un fichier sans transfert (section 8).

## 6. Le catalogue JSON, commenté

Le fichier de catalogue est un document JSON unique. Deux règles le parcourent de bout en bout :

- **tout nombre est écrit entre guillemets**, comme du texte. C'est ce qui garantit qu'un montant à
  dix-huit décimales ne soit pas arrondi au passage par un lecteur JSON ;
- **un champ absent est absent**, jamais `null`. Il n'y a donc qu'une seule façon d'écrire « non
  renseigné », et un document écrit à la main a la même forme qu'un document exporté.

Les dates sont au format `AAAA-MM-JJ`, les instants au format `2026-09-24T18:03:11Z`.

```jsonc
{
  "schemaVersion": 1,          // version du format ; seul nombre non écrit comme du texte
  "generator": "kerdial",
  "exportedAt": "2026-09-24T18:03:11Z",
  "baseCurrency": "EUR",       // la devise de référence de l'installation
  "iconsIncluded": true,       // false si l'export a été demandé sans les icônes

  "instruments": [
    {
      "identity": {
        "kind": "SHARE",                 // SHARE, ETF, FUND, CRYPTO, INDEX ou SCPI
        "isin": "FR0000120073",          // absent pour CRYPTO et INDEX ; pour une SCPI : isin ou symbol
        "exchangeMic": "XPAR",           // absent pour CRYPTO et INDEX ; pour une SCPI : pas d'exchangeMic
        "symbol": "AI"                   // obligatoire pour CRYPTO et INDEX ; pour une SCPI : isin ou symbol
      },
      "private": false,
      "listingCurrency": "EUR",
      "displayName": "Air Liquide",
      "primaryIdentifier": "ISIN",       // ISIN ou SYMBOL
      "quotePolicy": "AUTO",             // AUTO, ou MANUAL_ONLY pour un titre non coté ; MANUAL_ONLY obligatoire pour une SCPI
      "status": "ACTIVE",                // ACTIVE, DELISTED ou MERGED
      "figi": "BBG000BLNNH6",            // facultatif
      "sectorCode": "MATERIAUX",         // facultatif ; l'un des codes de secteur de l'application
      "industryLabel": "Gaz industriels", // facultatif, texte libre
      "domicileCountry": "FR",           // facultatif, code pays ISO 3166-1 alpha-2
      "managementCompany": "…",          // facultatif, SCPI uniquement
      "subscriptionFeePct": "8.50",      // facultatif, SCPI uniquement, pourcentage de 0 à 100
      "providerMapping": {               // facultatif : le fournisseur de cours retenu pour ce titre
        "providerKey": "yahoo",
        "providerSymbol": "AI.PA"
      },
      "icon": {                          // facultatif ; absent si iconsIncluded vaut false
        "contentType": "image/png",      // image/png ou image/jpeg
        "source": "MANUAL",              // MANUAL (téléversée) ou PROVIDER
        "base64": "iVBORw0KGgo…"
      },
      "manualPrices": [                  // les cours que vous avez saisis à la main
        { "priceDate": "2026-03-31", "close": "173.420000000000000000", "currency": "EUR" }
      ],
      "watchlist": {                     // facultatif : votre ligne de liste de suivi
        "targetPrice": "200.000000000000000000",
        "note": "Objectif de renforcement"
      }
    }
  ],

  "portfolios": [
    {
      "name": "PEA",
      "broker": "Bourse Direct",         // facultatif
      "description": "Plan d'épargne en actions", // facultatif
      "accentColor": "CHART_3",          // facultatif : CHART_1 à CHART_6
      "icon": {                          // facultatif ; une icône de portefeuille n'a pas de champ source
        "contentType": "image/png",
        "base64": "iVBORw0KGgo…"
      },
      "archived": true,                  // facultatif : présent seulement si le portefeuille est archivé
      "cashAccounts": [
        { "name": "Espèces EUR", "currency": "EUR", "archived": false }
      ]
    }
  ],

  "fxRatesUser": [                       // les taux de change que vous avez fixés vous-même
    { "baseCurrency": "EUR", "quoteCurrency": "USD", "rateDate": "2026-03-31", "rate": "1.082400000000" }
  ]
}
```

Les trois listes `instruments`, `portfolios` et `fxRatesUser` sont obligatoires ; elles peuvent être
vides. `schemaVersion` est obligatoire : un document dont la version est absente ou inconnue est
refusé en entier, sans rien écrire.

**Le code ISIN est vérifié, jamais refusé.** Un ISIN doit compter exactement douze caractères — c'est
ce que l'application enregistre. À l'import, la clé de contrôle ISO 6166 (le douzième caractère) est
en plus comparée aux onze premiers ; si elle ne correspond pas, le titre est **importé quand même** et
un avertissement le signale à l'étape de revue comme au résultat, sans bloquer la confirmation. Un
export se réimporte donc toujours, y compris lorsqu'il contient un titre créé à la main avec un ISIN
mal recopié : l'avertissement indique seulement quel code vérifier dans l'application.

Enfin, une entrée `"private": true` n'est pas importable : tous les titres sont partagés par
l'installation, et il n'existe aujourd'hui aucun moyen d'en créer un qui ne le soit pas.

## 7. Portfolio Performance et Kerdial, et l'ordre d'import

**Les deux formats coexistent, aucun ne remplace l'autre.** Kerdial importe toujours les fichiers
Portfolio Performance (titres, espèces, compte-titres) exactement comme avant ; le format Kerdial
s'ajoute, pour la sauvegarde et la restauration. En revanche, **un export est toujours au format
Kerdial** : l'application n'écrit pas de fichier Portfolio Performance.

**Un CSV d'opérations importé seul est un import complet et pris en charge.** Le portefeuille et le
compte espèces qu'il nomme sont créés s'ils n'existent pas — le compte avec la devise indiquée par
`cash_account_currency`. Il n'y a rien d'autre à préparer.

**Une exception, et c'est la seule : les titres doivent exister avant.** Une ligne d'opération porte
l'identité d'un titre (ISIN, place, symbole) mais ni sa nature (action, ETF, crypto…) ni sa devise de
cotation : elle ne contient pas de quoi créer le titre. Une ligne dont le titre est inconnu est
rejetée seule, avec la raison « L'instrument de cette ligne n'a pas pu être identifié ». Trois façons
de les créer d'abord :

1. **importer le catalogue JSON** exporté par Kerdial — c'est le cas de la restauration d'une
   sauvegarde, et l'ordre naturel est alors : catalogue, puis opérations ;
2. **importer le fichier « titres » de Portfolio Performance**, qui, lui, porte la nature et la
   devise et propose la création de chaque titre ;
3. **créer les titres dans l'application**, par la recherche de l'écran « Instruments ».

### Comment un import se raccorde à ce qui existe déjà

| Élément | Rapprochement | En cas de conflit |
| --- | --- | --- |
| Portefeuille | par son **nom** | — |
| Compte espèces | par son nom **à l'intérieur de son portefeuille** | si le compte existe avec une autre devise, la ligne est rejetée ; ni le compte ni sa devise ne sont modifiés |
| Titre | par son identité (ISIN + place, ou symbole) | le titre existant est réutilisé, jamais dupliqué |
| Opération | par son **empreinte** (voir ci-dessous) | la ligne est ignorée, jamais écrite deux fois |

**L'empreinte d'une opération** est une valeur calculée à partir de la ligne elle-même — sa date, sa
nature, son titre, ses montants, son portefeuille. Elle est enregistrée avec l'opération, et la
colonne `import_fingerprint` la transporte d'un fichier à l'autre. C'est ce qui rend un import
**réexécutable sans risque** : réimporter deux fois le même fichier n'écrit pas les lignes deux fois,
les secondes sont ignorées avec la mention « Cette ligne a déjà été importée (ou restaurée depuis une
sauvegarde) ».

Deux conséquences à connaître :

- une opération importée puis **modifiée** dans l'application garde l'empreinte de sa ligne
  d'origine. Réimporter le fichier ne la restaure donc pas : la ligne est ignorée. Pour repartir de
  la valeur du fichier, supprimez l'opération puis réimportez ;
- ce rattachement **survit à une restauration**. Une opération restaurée depuis une sauvegarde
  arrive avec l'empreinte de la ligne dont elle provenait à l'origine, même dans une installation
  qui n'a jamais vu ce fichier-là. C'est sans effet — rien ne va chercher le fichier d'origine — mais
  cela explique qu'une ligne puisse être annoncée « déjà importée » dans une installation neuve.

Une opération **saisie à la main** n'a, elle, aucune empreinte : elle ne peut ni bloquer un import ni
être reconnue par lui. Si un fichier contient la même opération, elle sera ajoutée une seconde fois.

## 8. Limites, et quoi faire quand on les atteint

| Limite | Valeur | Remède |
| --- | --- | --- |
| Taille du CSV d'opérations | 8 Mio | découper le fichier par période et importer les morceaux l'un après l'autre |
| Nombre de lignes du CSV | 20 000 | idem |
| Taille du catalogue JSON | 32 Mio | ce sont les icônes qui pèsent : utiliser le lien « exporter le catalogue sans les icônes » de l'écran « Importer » |
| Taille d'une icône | 256 Kio par image | remplacer l'image dans l'application avant d'exporter |
| Durée d'une requête d'import | environ 25 secondes | voir « un gros fichier s'importe en plusieurs fois », ci-dessous |
| Ancienneté d'une opération | 25 ans avant aujourd'hui | voir « une opération trop ancienne », ci-dessous |

### Un gros fichier s'importe en plusieurs fois

L'écriture d'une opération recalcule l'historique du portefeuille concerné, et ce travail n'est pas
gratuit : un fichier de plusieurs milliers de lignes ne tient pas dans le temps imparti à une
requête. Ce n'est pas une erreur, et **rien n'est perdu** : les lignes déjà écrites le restent, et
l'écran d'import renvoie de lui-même le fichier, requête après requête, jusqu'à ce que toutes les
lignes aient été traitées. Une ligne « Import en cours : … / … lignes traitées » indique
l'avancement ; les lignes déjà écrites sont reconnues et ignorées à chaque reprise, et le résultat
affiché à la fin est celui de l'ensemble des reprises. Un fichier de 20 000 lignes demande de l'ordre
d'une trentaine de reprises ; un fichier de quelques centaines de lignes passe en une seule fois.

Le bouton **« Arrêter »** interrompt l'enchaînement à la fin de la requête en cours (celle-ci n'est
jamais coupée : ce qu'elle a écrit reste écrit). L'enchaînement s'arrête aussi de lui-même si une
requête échoue, si une reprise ne traite aucune ligne de plus que la précédente, ou après 100
requêtes. Dans tous ces cas, le bouton **« Continuer l'import »** reprend le fichier là où il en
était. Pour éviter l'attente, vous pouvez aussi découper le fichier par période.

### Une opération trop ancienne

Une opération datée de plus de **25 ans avant la date du jour** est refusée, ligne par ligne, et le
reste du fichier est importé normalement. La raison n'est pas que la ligne soit incorrecte : c'est
que l'application ne sait pas récupérer d'historique de cours au-delà de cette limite, si bien
qu'une opération plus ancienne ne pourrait jamais être valorisée correctement. Le message le dit
explicitement et donne la date plancher.

Deux conséquences pour une sauvegarde : cette limite **se déplace avec le calendrier**, donc un
fichier restauré dans plusieurs années peut voir ses lignes les plus anciennes refusées alors qu'il
s'était restauré sans erreur auparavant ; et une opération datée dans le futur est refusée de la même
manière.

### Ouvrir le CSV dans un tableur

Kerdial écrit vos cellules **telles que vous les avez saisies** : une note ou une référence qui
commence par `=`, `+`, `-`, `@`, une tabulation (U+0009) ou un retour chariot (U+000D) est écrite
ainsi, sans caractère ajouté. Certains tableurs interprètent une telle cellule comme une **formule**
à l'ouverture. N'ouvrez donc pas un fichier CSV
avec l'évaluation des formules activée si vous n'êtes pas l'auteur de son contenu. Dans l'autre sens,
il n'y a rien à craindre : Kerdial n'interprète jamais une cellule, il enregistre le texte tel quel.

## 9. Journal des versions du format

| Version | Date | Changements |
| --- | --- | --- |
| `kerdial-transactions v1`, `schemaVersion` 1 | 2026-09 | Première version publiée des deux formats. |
| `schemaVersion` 1 (inchangé) | 2026-10 | Clé facultative `archived` sur un portefeuille ; ajout facultatif, pas de changement de version. |
| `schemaVersion` 1 (inchangé) | 2026-10 | Type `SCPI` et clés facultatives `managementCompany`, `subscriptionFeePct` ; pas de changement de version. |
| `kerdial-transactions v1` (inchangé) | 2026-10 | Type d'opération `INTEREST` (intérêts sur liquidités) ; pas de changement de version — une version antérieure de Kerdial importe le reste du fichier et rejette chaque ligne `INTEREST` (`UNSUPPORTED_ROW_TYPE`) ; vérifiez le nombre de lignes rejetées. |
| `kerdial-transactions v1` (inchangé) | 2026-10 | Type d'opération `FEE` (frais de portefeuille) ; pas de changement de version — une version antérieure refuse chaque ligne FEE (UNSUPPORTED_ROW_TYPE) et importe les autres. |
| `kerdial-transactions v2` | 2026-11 | La retenue à la source d'un `DIVIDEND` ou d'un `INTEREST` est un seul montant, dans la devise du compte espèces : colonnes `withholding_currency`, `withholding_cash_account` et `wht_fx_rate` supprimées, `withholding_amount` conservée. Un fichier `v1` est refusé en entier ; un fichier sans ligne de version qui contient l'une des trois colonnes supprimées est refusé comme colonne inconnue. |

La version du CSV est portée par la ligne `# kerdial-transactions v2`, facultative à la lecture
(section 3). Celle du catalogue est portée par le champ `schemaVersion`, obligatoire (section 6).
Une version inconnue fait refuser le fichier en entier plutôt que d'en lire une partie : mieux vaut
un refus explicite qu'un import partiel silencieux.
