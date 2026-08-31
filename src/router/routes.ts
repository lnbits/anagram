import type { RouteRecordRaw } from 'vue-router';
import { loadChatsPage, loadContactsPage, loadSettingsPage } from './pageLoaders';

const routes: RouteRecordRaw[] = [
  {
    path: '/auth',
    name: 'auth',
    alias: '/login',
    component: () => import('pages/AuthPage.vue'),
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('pages/RegisterPage.vue'),
  },
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      {
        path: '',
        redirect: { name: 'chats' },
      },
      {
        path: 'chats/requests',
        name: 'chat-requests',
        component: loadChatsPage,
      },
      {
        path: 'chats/:pubkey?',
        name: 'chats',
        component: loadChatsPage,
      },
      {
        path: 'contacts/:pubkey?',
        name: 'contacts',
        component: loadContactsPage,
      },
      {
        path: 'settings',
        name: 'settings',
        component: loadSettingsPage,
        children: [
          {
            path: 'profile',
            name: 'settings-profile',
            component: () => import('pages/settings/ProfileSettingsPage.vue'),
          },
          {
            path: 'status',
            name: 'settings-status',
            component: () => import('pages/settings/StatusSettingsPage.vue'),
          },
          {
            path: 'theme',
            name: 'settings-theme',
            component: () => import('pages/settings/ThemeSettingsPage.vue'),
          },
          {
            path: 'relays',
            name: 'settings-relays',
            component: () => import('pages/settings/RelaysSettingsPage.vue'),
          },
          {
            path: 'notifications',
            name: 'settings-notifications',
            component: () => import('pages/settings/NotificationsSettingsPage.vue'),
          },
          {
            path: 'media-data-storage',
            name: 'settings-media-data-storage',
            component: () => import('pages/settings/MediaDataStorageSettingsPage.vue'),
          },
          {
            path: 'language',
            name: 'settings-language',
            component: () => import('pages/settings/LanguageSettingsPage.vue'),
          },
          {
            path: 'developer',
            name: 'settings-developer',
            component: () => import('pages/settings/DeveloperSettingsPage.vue'),
          },
        ],
      },
    ],
  },
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
];

export default routes;
