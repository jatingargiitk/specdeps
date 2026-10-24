export const MANIFEST_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const STATE_VERSION = 1;
export const PROPOSAL_VERSION = 1;
export const STATE_REL = '.specdeps/state.json';
export const PROPOSALS_DIR = '.specdeps/proposals';
export const MAX_SECTION_BYTES = 1_000_000;
export const SECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export function proposalRel(id: string): string {
  return `${PROPOSALS_DIR}/${id}.json`;
}
