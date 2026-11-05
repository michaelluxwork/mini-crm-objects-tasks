import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@supabase/supabase-js';
import { client } from './client';
import { actions, actionLabels, labels, type Building, type History, type Profile, type Status, type Task } from './domain';
import './style.css';

const date = (value: string) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
function message(error: unknown) { return error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Не удалось выполнить запрос. Проверьте соединение и обновите данные.'; }
function Badge({ status }: { status: Status }) { return <span className={`badge ${status}`}>{labels[status]}</span>; }
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!client) return; const { data } = client.auth.onAuthStateChange((_event, next) => setSession(next)); return () => data.subscription.unsubscribe(); }, []);
  if (!client) return <main className="setup"><p className="eyebrow">Объекты и задачи</p><h1>Подключите тестовую базу</h1><p>Приложение подготовлено к подключению Supabase. Данные и вход пока недоступны.</p><ol><li>Примените SQL-миграцию к отдельному тестовому проекту.</li><li>Создайте тестовых пользователей и назначьте им роли по README.</li><li>Заполните .env.local публичным URL и publishable key, затем перезапустите приложение.</li></ol><p>Секретный ключ service_role здесь не используется.</p></main>;
  if (session) return <Workspace key={session.user.id} session={session} />;
  return <main className="login"><form onSubmit={async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(''); setBusy(true);
    try { const { error } = await client!.auth.signInWithPassword({ email: String(form.get('email')), password: String(form.get('password')) }); if (error) throw error; }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  }}><p className="eyebrow">Объекты и задачи</p><h1>Вход в CRM</h1><p>Задачи по стройкам, исполнители и проверка результата.</p><fieldset disabled={busy}><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label><button className="primary">{busy ? 'Входим…' : 'Войти'}</button></fieldset>{error && <p className="error" role="alert">{error}</p>}<p className="muted">Доступ выдаёт администратор. Открытой регистрации нет.</p></form></main>;
}

function Workspace({ session }: { session: Session }) {
  const [route, setRoute] = useState(location.hash.slice(1) || 'objects');
  const [data, setData] = useState<{ profiles: Profile[]; objects: Building[]; tasks: Task[]; history: History[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => { const onHash = () => setRoute(location.hash.slice(1) || 'objects'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    const read = (table: string) => client!.from(table).select('*').abortSignal(controller.signal);
    // shortcut: single-page reads fit the demo fixtures; add pagination before using larger datasets.
    Promise.all([read('profiles'), read('objects'), read('tasks'), read('task_history')]).then(results => {
      if (controller.signal.aborted) return;
      const failure = results.find(result => result.error); if (failure?.error) throw failure.error;
      setData({ profiles: results[0].data as Profile[], objects: results[1].data as Building[], tasks: results[2].data as Task[], history: results[3].data as History[] });
    }).catch(error => { if (!controller.signal.aborted) { setData(null); setError(message(error)); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => { const refresh = () => setReload(value => value + 1); window.addEventListener('focus',refresh); return () => window.removeEventListener('focus',refresh); }, []);
  const profile = data?.profiles.find(person => person.id === session.user.id);
  const manager = profile?.role === 'manager';
  const personName = (id: string) => data?.profiles.find(person => person.id === id)?.display_name || 'Пользователь';
  const [page, id] = route.split('/');
  const object = data?.objects.find(item => item.id === id);
  const task = data?.tasks.find(item => item.id === id);
  async function mutate(name: string, args: Record<string, unknown>, next?: (result: unknown) => string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const { data: result, error } = await client!.rpc(name, args); if (error) throw error;
      setNotice('Изменения сохранены'); if (next) location.hash = next(result); setReload(value => value + 1);
    } catch (error) { setError(message(error)); setReload(value => value + 1); }
    finally { setBusy(false); }
  }
  const table = (tasks: Task[]) => tasks.length ? <div className="table-wrap"><table><thead><tr><th>Задача</th><th>Исполнитель</th><th>Статус</th></tr></thead><tbody>{[...tasks].sort((a,b) => b.created_at.localeCompare(a.created_at)).map(task => <tr key={task.id}><td><a href={`#task/${task.id}`}>{task.title}</a></td><td>{personName(task.assignee_id)}</td><td><Badge status={task.status} /></td></tr>)}</tbody></table></div> : <p className="empty">Задач пока нет.</p>;
  return <><header className="topbar"><a className="brand" href="#objects">Объекты и задачи</a><div className="account"><span>{profile ? `${profile.display_name} · ${manager ? 'Постановщик' : 'Исполнитель'}` : 'Загрузка профиля…'}</span><button disabled={busy} onClick={async () => { const { error } = await client!.auth.signOut(); if (error) setError(message(error)); }}>Выйти</button></div></header><div className="layout"><nav aria-label="Основная навигация"><a className={page === 'objects' || page === 'object' ? 'active' : ''} href="#objects">Объекты</a>{profile?.role === 'executor' && <a className={page === 'mine' ? 'active' : ''} href="#mine">Мои задачи</a>}<button disabled={busy || loading} onClick={() => { setError(''); setReload(value => value + 1); }}>Обновить данные</button></nav><main className="workspace" aria-busy={busy || loading}>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
    {loading ? <p role="status">Загружаем данные…</p> : !data ? <p>Данные не загружены. Нажмите «Обновить данные».</p> : !profile ? <section className="panel"><h1>Роль ещё не назначена</h1><p>Обратитесь к администратору: для учётной записи нужен профиль постановщика или исполнителя.</p></section> : <>
      {page === 'objects' ? <><h1>Объекты</h1><p className="muted">{manager ? 'Все стройки и задачи команды.' : 'Стройки, на которых вам назначены задачи.'}</p><div className="object-grid">{data.objects.map(object => <a className="object-card" key={object.id} href={`#object/${object.id}`}><h2>{object.name}</h2><p>{object.address}</p><span>{data.tasks.filter(task => task.object_id === object.id).length} задач</span></a>)}</div>{!data.objects.length && <p className="empty">Объектов пока нет.</p>}{manager && <section className="panel"><h2>Добавить объект</h2><ObjectForm busy={busy} submit={(name,address) => mutate('create_object',{p_name:name,p_address:address}, id => `object/${id}`)} /></section>}</>
      : page === 'mine' && !manager ? <><h1>Мои задачи</h1>{table(data.tasks.filter(task => task.assignee_id === profile.id))}</>
      : page === 'object' && object ? <><a href="#objects">← Все объекты</a><h1>{object.name}</h1><p className="muted">{object.address}</p><h2>Задачи объекта</h2>{table(data.tasks.filter(task => task.object_id === object.id))}{manager && <><section className="panel"><h2>Новая задача</h2><TaskForm key={`new-${object.id}-${reload}`} profiles={data.profiles} busy={busy} submit={(title,description,assignee) => mutate('create_task',{p_object_id:object.id,p_title:title,p_description:description,p_assignee_id:assignee}, id => `task/${id}`)} /></section><details className="panel"><summary>Редактировать объект</summary><ObjectForm key={object.id + reload} object={object} busy={busy} submit={(name,address) => mutate('update_object',{p_id:object.id,p_name:name,p_address:address})} /><button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Удалить объект «${object.name}»? Удалить можно только пустой объект.`)) void mutate('delete_object',{p_object_id:object.id},()=> 'objects'); }}>Удалить объект</button></details></>}</>
      : page === 'task' && task ? <><a href={`#object/${task.object_id}`}>← {data.objects.find(item => item.id === task.object_id)?.name || 'Объект'}</a><div className="title-row"><h1>{task.title}</h1><Badge status={task.status} /></div><section className="panel"><p className="description">{task.description || 'Описание не добавлено.'}</p><dl><div><dt>Исполнитель</dt><dd>{personName(task.assignee_id)}</dd></div><div><dt>Автор</dt><dd>{personName(task.author_id)}</dd></div><div><dt>Создана</dt><dd>{date(task.created_at)}</dd></div></dl></section><Transition key={`${task.id}-${task.status}-${reload}`} task={task} profile={profile} busy={busy} submit={(status,comment) => mutate('transition_task',{p_task_id:task.id,p_expected_status:task.status,p_to_status:status,p_comment:comment})} />{manager && <details className="panel"><summary>Редактировать задачу</summary><TaskForm key={task.id + reload} task={task} profiles={data.profiles} objects={data.objects} busy={busy} submit={(title,description,_assignee,objectId) => mutate('update_task_details',{p_id:task.id,p_title:title,p_description:description,p_object_id:objectId || task.object_id})} /><ReassignForm key={`assignee-${task.id}-${reload}`} task={task} profiles={data.profiles} busy={busy} submit={assignee => mutate('reassign_task',{p_task_id:task.id,p_expected_assignee_id:task.assignee_id,p_assignee_id:assignee})} /><button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Удалить задачу «${task.title}» вместе со всей историей?`)) void mutate('delete_task',{p_task_id:task.id},()=> `object/${task.object_id}`); }}>Удалить задачу</button></details>}<h2>История задачи</h2><ol className="history">{data.history.filter(item => item.task_id === task.id).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id - b.id).map(item => <li key={item.id}><p><strong>{item.from_status ? `${labels[item.from_status]} → ${labels[item.to_status]}` : 'Задача создана'}</strong></p><p className="muted">{personName(item.actor_id)} · {date(item.created_at)}</p>{item.comment && <p className="description">{item.comment}</p>}</li>)}</ol></>
      : <section className="panel"><h1>Страница недоступна</h1><p>Возможно, запись удалена или у вас нет к ней доступа.</p><a href="#objects">К списку объектов</a></section>}
    </>}
  </main></div></>;
}

function ObjectForm({ object, busy, submit }: { object?: Building; busy: boolean; submit: (name:string,address:string) => Promise<void> }) {
  return <form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit(String(form.get('name')),String(form.get('address'))); }}><fieldset disabled={busy}><label>Название<input name="name" defaultValue={object?.name} required maxLength={200} /></label><label>Адрес<input name="address" defaultValue={object?.address} required maxLength={500} /></label><button className="primary">{busy ? 'Сохраняем…' : object ? 'Сохранить объект' : 'Создать объект'}</button></fieldset></form>;
}
function TaskForm({ task, profiles, objects, busy, submit }: { task?: Task; profiles: Profile[]; objects?: Building[]; busy: boolean; submit:(title:string,description:string,assignee:string,objectId?:string) => Promise<void> }) {
  return <form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit(String(form.get('title')),String(form.get('description')),String(form.get('assignee') || task?.assignee_id || ''),String(form.get('object_id') || task?.object_id || '')); }}><fieldset disabled={busy}><label>Название<input name="title" defaultValue={task?.title} required maxLength={200}/></label><label>Описание<textarea name="description" defaultValue={task?.description} maxLength={5000} rows={4}/></label>{!task && <label>Исполнитель<select name="assignee" required defaultValue=""><option value="" disabled>Выберите исполнителя</option>{profiles.filter(person => person.role === 'executor').map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label>}{task && objects && <label>Объект задачи<select name="object_id" defaultValue={task.object_id} required>{objects.map(object => <option key={object.id} value={object.id}>{object.name}</option>)}</select></label>}<button className="primary">{busy ? 'Сохраняем…' : task ? 'Сохранить задачу' : 'Создать задачу'}</button></fieldset></form>;
}
function ReassignForm({ task, profiles, busy, submit }: { task:Task; profiles:Profile[]; busy:boolean; submit:(assignee:string)=>Promise<void> }) {
  const [assignee,setAssignee] = useState(task.assignee_id);
  return <form className="reassign" onSubmit={event => { event.preventDefault(); void submit(assignee); }}><fieldset disabled={busy}><label>Новый исполнитель<select value={assignee} onChange={event => setAssignee(event.target.value)} required>{profiles.filter(person => person.role === 'executor').map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label><button disabled={busy || assignee === task.assignee_id}>Переназначить задачу</button></fieldset></form>;
}
function Transition({ task, profile, busy, submit }: { task:Task; profile:Profile; busy:boolean; submit:(status:Status,comment:string) => Promise<void> }) {
  const available = actions(task,profile); const [comment,setComment] = useState('');
  if (!available.length) return <p className="muted">{task.status === 'accepted' ? 'Задача завершена.' : task.status === 'review' ? 'Ожидается проверка постановщиком.' : 'Ожидается действие исполнителя.'}</p>;
  return <section className="panel"><h2>Действия</h2><label>Комментарий{available.includes('rework') && ' (обязателен для доработки)'}<textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} disabled={busy} rows={3}/></label><div className="actions">{available.map(status => <button className={status === 'rework' ? '' : 'primary'} key={status} disabled={busy || (status === 'rework' && !comment.trim())} onClick={() => void submit(status,comment)}>{actionLabels[status]}</button>)}</div></section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
