import { resolveByName, type OrganizationRef } from '@patroltech/agent-capabilities';
import { refuse, type ToolRefusal } from '../ToolOutcome.js';

const namesOf = (organizations: readonly OrganizationRef[]): string[] =>
  organizations.map((o) => o.name);

/**
 * La organización sobre la que actuar, SOLO entre las del usuario (anti-fuga): con una sola, esa
 * (si `requested` viene, tiene que ser ella: con otra, el modelo daría sus datos como los de la
 * otra); con varias, la que nombre `requested` (nombre, parte inequívoca de él o id). Si falta,
 * no casa o es ambigua, una negativa con los nombres para que el modelo repita la llamada.
 */
export function selectOrganization(
  organizations: readonly OrganizationRef[],
  requested: string | undefined
): OrganizationRef | ToolRefusal {
  if (organizations.length === 0) {
    return refuse(
      'no_organization',
      'This PatrolTech account has no organization yet, so there is nothing to read.'
    );
  }
  const options = namesOf(organizations);
  if (organizations.length === 1 && !requested?.trim()) return organizations[0];
  if (!requested?.trim()) {
    return refuse(
      'organization_required',
      'This account has more than one organization. Repeat the call with `organization` set to one of the listed names.',
      options
    );
  }
  const match = resolveByName(requested, organizations, (o) => o.name, { idOf: (o) => o.orgId });
  if (match.kind === 'found') return match.item;
  if (match.kind === 'ambiguous') {
    return refuse(
      'organization_ambiguous',
      `"${requested}" matches more than one organization. Repeat the call with the exact name.`,
      namesOf(match.matches)
    );
  }
  return refuse(
    'organization_unknown',
    `"${requested}" is not one of this account's organizations. Repeat the call with one of the listed names.`,
    options
  );
}

/**
 * Para lo que solo afecta al usuario (`scope: 'user'`): cualquiera de sus organizaciones, sin que
 * elija. Vale la primera porque esas capacidades piden el rol mínimo (VIEWER); si alguna pidiera
 * más, habría que elegir la primera en la que el rol del usuario lo permita.
 */
export function anyOrganization(
  organizations: readonly OrganizationRef[]
): OrganizationRef | ToolRefusal {
  return (
    organizations[0] ??
    refuse(
      'no_organization',
      'This PatrolTech account has no organization yet, so this cannot be done.'
    )
  );
}
