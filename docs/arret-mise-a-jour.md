# Arrêter une mise à jour non validable

Une proposition qui conserve des vulnérabilités ne passe pas la barrière de publication. Si aucune combinaison sûre et compatible ne peut être validée dans la recherche bornée, la tentative se termine en échec. Elle ne repart pas automatiquement. Les contrôles périodiques de surveillance restent indépendants et continuent.

Le suivi affiche « Mise à jour arrêtée », la raison conservée par l’exécuteur (alertes restantes, incompatibilité, validation échouée, catalogue indisponible ou limite de recherche) et les derniers signalements par composant/version. Les versions correctrices ne sont indiquées que si le rapport les référence ; leur absence dans le rapport ne prouve pas qu’aucun correctif n’existe. Une limite atteinte signifie qu’aucune solution n’a été validée dans cette recherche, pas qu’aucune solution ne peut exister.

Avant toute publication, le suivi confirme qu’aucune nouvelle version n’a été publiée par la tentative. Si des opérations ont déjà pu avoir lieu sur un service, il indique au contraire que l’état installé doit être vérifié et que le résultat global n’est pas validé. Les références de publication et les sauvegardes restent dans le compte rendu.
