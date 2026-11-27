# Contribuer à grammai

[English](CONTRIBUTING.md) | **Français**

Merci de contribuer à rendre l'aide à la rédaction plus facile à utiliser.

## Démarrer en local

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Utilisez Node.js 22 ou une version plus récente, puis chargez le répertoire `dist` depuis la page de gestion des extensions de votre navigateur. La correction grammaticale fonctionne sans l'utilitaire local d'IA. Consultez la [documentation de développement](docs/development.md) pour connaître l'organisation du code et les tests dans le navigateur.

## Signaler un bug

Utilisez le [suivi des issues](https://github.com/zilvestro/grammai/issues) ou envoyez un e-mail à grammai@zaapp.io. Indiquez le navigateur et sa version, le site et l'éditeur concernés, le comportement attendu et un court exemple permettant de reproduire le problème. Anonymisez les textes et les captures d'écran. N'incluez jamais de mots de passe, de clés API, de jetons d'accès aux fournisseurs ou de brouillons privés.

Pour les bugs d'édition, précisez si la saisie, la touche Retour arrière, la sélection et la suppression de tout le texte, ainsi que l'annulation fonctionnent toujours après l'action. Pour les bugs de grammaire, fournissez un contre-exemple correct afin qu'une correction ciblée n'introduise pas de nouveau faux positif.

## Proposer une modification

Créez un fork de [zilvestro/grammai](https://github.com/zilvestro/grammai), créez une branche, enregistrez votre modification dans un commit et ouvrez une pull request vers `main`. Pour les fonctionnalités plus importantes, discutez d'abord du périmètre dans une issue.

Gardez les modifications ciblées. Expliquez le problème rencontré par les utilisateurs, le comportement obtenu et les vérifications effectuées. Lancez la vérification des types et les contrôles pertinents pour les fichiers modifiés. Ajoutez un test de non-régression pour les bugs de comportement ; les changements d'espacement et de texte nécessitent généralement une vérification visuelle plutôt qu'un test qui reproduit l'implémentation.

Préservez la sélection native, la mise en forme de l'éditeur, l'accès au clavier, les préférences d'apparence et les protections contre les résultats périmés. Conservez les vérifications ordinaires en local. N'ajoutez jamais d'outils d'analyse d'usage, de traitement du texte à distance ou de nouvelles autorisations sans décrire explicitement le comportement proposé.

Exécutez Prettier sur les fichiers modifiés qu'il prend en charge. N'incluez pas de fichiers générés, de profils de navigateur, de captures de recherche, d'identifiants ou de configuration personnelle dans une contribution. Le fichier `src/generated/dictionaries.ts` est régénéré lors de la compilation.

## Licence

Les contributions au code original de grammai sont soumises à la licence GPL-3.0-only. Préservez les mentions et les licences d'origine lorsque vous modifiez ou redistribuez des composants tiers. Consultez la [licence](LICENSE) et les [mentions relatives aux composants tiers](THIRD_PARTY_NOTICES.md).
