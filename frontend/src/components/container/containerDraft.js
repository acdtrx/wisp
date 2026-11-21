/**
 * The New container form's draft: the only state of a container being created. `app`
 * is an app's id, or null for a plain container; `image` is what it runs (an app fills
 * in its own default). `createContainerBody` turns it into the create request once, at
 * submit.
 */

export const defaultContainerDraft = () => ({ name: '', app: null, image: '' });

/** The draft once `app` is picked (`apps`: the app list, `{ id, defaultImage }`): an app
 *  fills in its image, a plain container starts with none. */
export function draftWithApp(draft, app, apps) {
  const entry = apps.find((a) => a.id === app) ?? null;
  return { ...draft, app: entry ? entry.id : null, image: entry ? entry.defaultImage : '' };
}

/** What keeps the draft from being created, by field (none: an empty object). */
export function containerDraftProblems(draft) {
  const problems = {};
  if (draft.name.trim() === '') problems.name = 'A name is required.';
  if (draft.image.trim() === '') problems.image = 'An image is required.';
  return problems;
}

/** The create request (`POST /api/containers`) for the draft. */
export function createContainerBody(draft) {
  const body = { name: draft.name.trim(), image: draft.image.trim() };
  if (draft.app) body.app = draft.app;
  return body;
}
