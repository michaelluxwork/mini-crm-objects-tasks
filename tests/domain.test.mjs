import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actions } from '../src/domain.ts';
import { isPublicKey, isAllowedSupabaseUrl } from '../src/public-key.ts';

test('plain HTTP is allowed only on exact loopback hosts', () => {
  for (const url of ['https://project.supabase.co','http://127.0.0.1:4377','http://localhost:4377','http://[::1]:4377']) assert.equal(isAllowedSupabaseUrl(url),true,url);
  for (const url of ['http://example.com','http://localhost.evil.com','http://127.0.0.1.evil.com','http://user:pass@localhost','ftp://localhost','invalid']) assert.equal(isAllowedSupabaseUrl(url),false,url);
});

test('only public key kinds accepted, including legacy anon JWT', () => {
  const jwt = role => `e30.${btoa(JSON.stringify({role}))}.fixture`;
  assert.equal(isPublicKey('sb_publishable_fixture'),true);
  assert.equal(isPublicKey(jwt('anon')),true);
  for (const key of [jwt('service_role'),'sb_secret_fixture','not-a-key','']) assert.equal(isPublicKey(key),false);
});

test('UI actions are role, ownership and status dependent', () => {
  const executor = { id:'a',role:'executor',display_name:'A' };
  const manager = { id:'m',role:'manager',display_name:'M' };
  for (const status of ['new','in_progress','review','accepted','rework']) {
    const task = { id:'t',assignee_id:'a',status };
    assert.deepEqual(actions(task,{ ...executor,id:'b' }),[]);
    assert.deepEqual(actions(task,executor), status === 'new' || status === 'rework' ? ['in_progress'] : status === 'in_progress' ? ['review'] : []);
    assert.deepEqual(actions(task,manager), status === 'review' ? ['accepted','rework'] : []);
  }
});
