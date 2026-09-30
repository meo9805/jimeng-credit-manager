export function teamManagementById(policies = []) {
  return new Map(policies.filter(item => item?.spaceId).map(item => [String(item.spaceId), item]));
}

export function archivedTeamIds(teams = [], policies = []) {
  const archived = new Set(teams.filter(team => team?.archived === true && team.spaceId).map(team => String(team.spaceId)));
  for (const policy of policies) {
    if (!policy?.spaceId) continue;
    if (policy.archived === true) archived.add(String(policy.spaceId));
    else if (policy.archived === false) archived.delete(String(policy.spaceId));
  }
  return archived;
}
