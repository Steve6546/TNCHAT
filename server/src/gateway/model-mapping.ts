import { GatewayError } from '../core/errors.js';
import { parseStringRecord } from '../lib/json.js';

/**
 * Model redirection.
 *
 * Two behaviours are load-bearing and are preserved exactly:
 *
 *  1. **Chained redirects.** `{"a":"b","b":"c"}` resolves `a` to `c`, not `b`.
 *     Chains are what let one client-facing name fan out through several
 *     renaming layers (alias → real name → provider name).
 *
 *  2. **Cycle detection.** `{"a":"b","b":"a"}` must not spin forever. There is
 *     one subtle rule: a self-referential entry that is also the originally
 *     requested model is treated as *not mapped* (a no-op), while a cycle
 *     reached later in the chain is a hard error.
 */

export interface ModelMappingResult {
  /** Model name to send upstream. Equals the requested name when unmapped. */
  upstreamModel: string;
  isMapped: boolean;
}

export function parseModelMapping(raw: string | null | undefined): Record<string, string> {
  return parseStringRecord(raw);
}

export function resolveModelMapping(
  requestedModel: string,
  mapping: Record<string, string>,
): ModelMappingResult {
  if (Object.keys(mapping).length === 0) {
    return { upstreamModel: requestedModel, isMapped: false };
  }

  let currentModel = requestedModel;
  let isMapped = false;
  const visited = new Set<string>([currentModel]);

  for (;;) {
    const mapped = mapping[currentModel];
    if (mapped === undefined || mapped === '') break;

    if (visited.has(mapped)) {
      // A self-reference on the model the client actually asked for is a
      // no-op, not a cycle. Anything else is a loop and must be reported.
      if (mapped === currentModel) {
        if (currentModel === requestedModel) {
          return { upstreamModel: requestedModel, isMapped: false };
        }
        isMapped = true;
        break;
      }
      throw GatewayError.badRequest(
        `model_mapping contains a cycle involving "${mapped}"`,
        'model_mapping',
      );
    }

    visited.add(mapped);
    currentModel = mapped;
    isMapped = true;
  }

  return { upstreamModel: currentModel, isMapped };
}
