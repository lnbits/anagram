import { Screen } from 'quasar';
import { boot } from 'quasar/wrappers';
import { MOBILE_BREAKPOINT_PX } from 'src/config/responsiveBreakpoints';

export default boot(() => {
  Screen.setSizes({ sm: MOBILE_BREAKPOINT_PX });
});
