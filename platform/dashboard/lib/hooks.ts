'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from './api';

export function useProjectId(): string {
  const p = useParams<{ id: string }>();
  return p.id;
}

export function useProject(id: string) {
  return useQuery({ queryKey: ['project', id], queryFn: () => api.get(`/projects/${id}`) });
}
