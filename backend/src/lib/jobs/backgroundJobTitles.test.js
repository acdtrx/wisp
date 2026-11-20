import { test } from 'node:test';
import assert from 'node:assert/strict';

import { titleForLibraryDownloadUrl } from './backgroundJobTitles.js';

test('a download title is the URL without userinfo, query or fragment', () => {
  assert.equal(
    titleForLibraryDownloadUrl('https://user:s3cret@example.com/images/disk.qcow2?X-Amz-Signature=abc&token=t#part'),
    'https://example.com/images/disk.qcow2',
  );
  assert.equal(titleForLibraryDownloadUrl('http://example.com'), 'http://example.com/');
});

test('a download title is cut to 56 characters after the secrets are gone', () => {
  const url = `https://example.com/${'a'.repeat(60)}.iso?token=${'x'.repeat(40)}`;
  const title = titleForLibraryDownloadUrl(url);
  assert.equal(title.length, 54);
  assert.equal(title, `${`https://example.com/${'a'.repeat(60)}`.slice(0, 53)}…`);
  assert.equal(titleForLibraryDownloadUrl('https://example.com/short.iso?token=abc'), 'https://example.com/short.iso');
});
