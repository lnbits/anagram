import { useQuasar } from 'quasar';
import { useDesktopSidebarWidth } from 'src/composables/useDesktopSidebarWidth';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

export type SectionShellRail = 'chats' | 'contacts' | 'settings';

interface UseSectionShellOptions {
  activeSection: SectionShellRail;
  errorContext: string;
  resolveHeight?: (fallbackHeight: number) => number;
}

const sectionRouteNameByRail: Record<SectionShellRail, SectionShellRail> = {
  chats: 'chats',
  contacts: 'contacts',
  settings: 'settings',
};

export function useSectionShell({
  activeSection,
  errorContext,
  resolveHeight,
}: UseSectionShellOptions) {
  const $q = useQuasar();
  const router = useRouter();
  const isMobile = computed(() => $q.screen.lt.sm);
  const desktopSidebar = useDesktopSidebarWidth(isMobile);

  function buildPageStyle(offset: number, height: number): Record<string, string> {
    const effectiveOffset = isMobile.value ? 0 : offset;
    const pageHeight = Math.max(
      (resolveHeight ? resolveHeight(height) : height) - effectiveOffset,
      0
    );

    return {
      height: `${pageHeight}px`,
      minHeight: `${pageHeight}px`,
    };
  }

  function handleRailSelect(section: SectionShellRail): void {
    try {
      if (section === activeSection) {
        return;
      }

      void router.push({ name: sectionRouteNameByRail[section] });
    } catch (error) {
      reportUiError(errorContext, error);
    }
  }

  return {
    isMobile,
    buildPageStyle,
    handleRailSelect,
    ...desktopSidebar,
  };
}
