import { describe, expect, it } from 'vitest';
import {
  asStoredJson,
  readStoredProposal,
  toStoredParams,
  type StoredProposal,
} from './storedProposal.js';

const proposal: StoredProposal = {
  params: { ruta: 'Noche', ruta_id: 'r-1', checkpoint_id: 'c-1', operacion: 'añadir', orden: 4 },
  summary: 'Add the checkpoint «Puerta» at the end of the route «Noche».',
  routeChanges: [{ rutaId: 'r-1', checkpointId: 'c-1', op: 'añadir' }],
};

describe('stored proposal params', () => {
  it('round-trips the prepared params, the summary and the route changes', () => {
    const stored = toStoredParams(proposal);
    expect(readStoredProposal(JSON.parse(JSON.stringify(stored)))).toEqual(proposal);
  });

  it('marks the format so a foreign or older record is never executed by mistake', () => {
    expect(toStoredParams(proposal)).toMatchObject({ format: 'mcp-proposal/1' });
    expect(readStoredProposal({ ...toStoredParams(proposal), format: 'other' })).toBeUndefined();
    expect(readStoredProposal(proposal.params)).toBeUndefined();
    expect(readStoredProposal(null)).toBeUndefined();
    expect(readStoredProposal('text')).toBeUndefined();
  });

  it('rejects malformed route changes', () => {
    const broken = { ...toStoredParams(proposal), routeChanges: [{ rutaId: 'r-1', op: 'move' }] };
    expect(readStoredProposal(broken)).toBeUndefined();
  });
});

describe('asStoredJson', () => {
  it('drops undefined keys, as the store does, so a fresh proposal equals the stored one', () => {
    expect(asStoredJson({ a: 1, b: undefined, c: { d: undefined, e: 'x' } })).toEqual({
      a: 1,
      c: { e: 'x' },
    });
    expect(Object.keys(asStoredJson({ a: 1, b: undefined }))).toEqual(['a']);
  });
});
