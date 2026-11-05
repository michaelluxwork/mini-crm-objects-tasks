export type Role = 'manager' | 'executor';
export type Status = 'new' | 'in_progress' | 'review' | 'accepted' | 'rework';
export type Profile = { id: string; display_name: string; role: Role };
export type Building = { id: string; name: string; address: string; created_at: string };
export type Task = { id: string; object_id: string; title: string; description: string; assignee_id: string; status: Status; author_id: string; created_at: string };
export type History = { id: number; task_id: string; actor_id: string; from_status: Status | null; to_status: Status; comment: string | null; created_at: string };
export const labels: Record<Status, string> = { new: 'Новая', in_progress: 'В работе', review: 'На проверке', accepted: 'Принята', rework: 'На доработке' };
export function actions(task: Task, profile: Profile): Status[] {
  if (profile.role === 'manager') return task.status === 'review' ? ['accepted', 'rework'] : [];
  if (task.assignee_id !== profile.id) return [];
  if (task.status === 'new' || task.status === 'rework') return ['in_progress'];
  return task.status === 'in_progress' ? ['review'] : [];
}
export const actionLabels: Partial<Record<Status, string>> = { in_progress: 'Взять в работу', review: 'Отправить на проверку', accepted: 'Принять', rework: 'Вернуть на доработку' };
