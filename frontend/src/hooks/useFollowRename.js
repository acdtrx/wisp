import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { renamedElsewhere, renamedPath } from '../utils/renamedPath.js';

/**
 * A workload page whose record is gone follows the workload to its new name when the
 * list shows its uuid under another one (a rename made elsewhere), keeping the tab: it
 * looks again whenever the list changes while the gone page shows.
 *
 * @param {'vm' | 'container'} kind
 * @param {string} name — the name the page shows
 * @param {{ status: string, data: any }} record — the page's config record
 * @param {unknown} list — the kind's list
 */
export function useFollowRename(kind, name, record, list) {
  const navigate = useNavigate();
  /* The uuid the record last had for this name (a gone record has no data). */
  const [seen, setSeen] = useState({ name: null, uuid: null });
  const uuid = record.data?.uuid ?? null;
  if (uuid && (seen.name !== name || seen.uuid !== uuid)) setSeen({ name, uuid });
  const target = renamedElsewhere({ gone: record.status === 'gone', uuid: seen.name === name ? seen.uuid : null, name, list });
  useEffect(() => {
    if (!target) return;
    const path = renamedPath(window.location.pathname, kind, name, target);
    if (path) navigate(path, { replace: true });
  }, [kind, name, target, navigate]);
}
