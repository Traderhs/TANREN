#[derive(Debug, Default)]
pub struct WindowsInputAdapter {
    #[cfg(windows)]
    previous: Option<PreviousInputProfile>,
    #[cfg(windows)]
    target_window: Option<usize>,
    active_language: Option<String>,
}

#[cfg(windows)]
pub type InputWindow = windows::Win32::Foundation::HWND;
#[cfg(not(windows))]
pub type InputWindow = ();

#[cfg(windows)]
#[derive(Debug)]
struct PreviousInputProfile {
    hkl: usize,
    tsf: Option<StoredTsfProfile>,
}

#[cfg(windows)]
#[derive(Debug, Clone)]
struct StoredTsfProfile {
    profile_type: u32,
    langid: u16,
    clsid: windows::core::GUID,
    guid: windows::core::GUID,
    hkl: usize,
}

impl WindowsInputAdapter {
    pub fn remember_current(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows::Win32::{UI::{Input::KeyboardAndMouse::GetKeyboardLayout, WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId}}};
            if self.previous.is_some() { return Ok(()); }
            let hwnd = unsafe { GetForegroundWindow() };
            let thread_id = unsafe { GetWindowThreadProcessId(hwnd, None) };
            let hkl = unsafe { GetKeyboardLayout(thread_id) };
            self.previous = Some(PreviousInputProfile { hkl: hkl.0 as usize, tsf: current_tsf_profile() });
        }
        Ok(())
    }

    pub fn activate_for_language(&mut self, language: &str, owner_window: InputWindow) -> Result<Option<String>, String> {
        #[cfg(windows)]
        {
            let (langid, klid) = match language {
                "ja-JP" => (0x0411, "00000411"),
                "ko-KR" => (0x0412, "00000412"),
                _ => return Ok(None),
            };
            let target_window = focused_input_window(owner_window);
            self.target_window = Some(target_window.0 as usize);
            let profile_changed = self.active_language.as_deref() != Some(language);

            if profile_changed {
                match activate_tsf_profile(langid) {
                    Ok(()) => {
                        activate_window_layout(target_window, klid).map_err(|error| format!("{language} input profile could not be applied to the focused answer field: {error}"))?;
                        self.active_language = Some(language.to_string());
                    }
                    Err(tsf_error) => {
                        activate_window_layout(target_window, klid).map_err(|imm_error| format!("{language} input profile is unavailable (TSF: {tsf_error}; IMM fallback: {imm_error})"))?;
                        self.active_language = Some(language.to_string());
                        let mut warning = format!("TSF input profile activation was unavailable; using the Windows layout fallback for {language}.");
                        if let Err(mode_error) = set_native_imm_mode(target_window, language) {
                            warning.push_str(&format!(" Native input mode could not be forced: {mode_error}"));
                        }
                        return Ok(Some(warning));
                    }
                }
            }

            if matches!(language, "ja-JP" | "ko-KR") {
                if let Err(tsf_error) = set_native_tsf_mode(language) {
                    if let Err(imm_error) = set_native_imm_mode(target_window, language) {
                        return Ok(Some(format!("{language} input profile is active, but native input mode could not be forced (TSF: {tsf_error}; IMM: {imm_error})")));
                    }
                } else {
                    // TSF compartments are process-wide; also assert the focused WebView's IMM context.
                    let _ = set_native_imm_mode(target_window, language);
                }
            }
            return Ok(None);
        }
        #[cfg(not(windows))]
        {
            let _ = (language, owner_window);
            Ok(None)
        }
    }

    pub fn restore(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Some(previous) = self.previous.take() {
                let restored_by_tsf = previous.tsf.as_ref().is_some_and(|profile| activate_tsf_exact(profile).is_ok());
                if let Some(window) = self.target_window.take() {
                    request_window_layout(windows::Win32::Foundation::HWND(window as *mut core::ffi::c_void), previous.hkl)?;
                } else if !restored_by_tsf {
                    activate_layout(previous.hkl)?;
                }
            }
        }
        self.active_language = None;
        Ok(())
    }
}

#[cfg(windows)]
struct ComGuard(bool);

#[cfg(windows)]
impl ComGuard {
    fn initialize() -> Result<Self, String> {
        use windows::Win32::{Foundation::RPC_E_CHANGED_MODE, System::Com::{CoInitializeEx, COINIT_MULTITHREADED}};
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() { Ok(Self(true)) }
        else if result == RPC_E_CHANGED_MODE { Ok(Self(false)) }
        else { Err(windows::core::Error::from(result).to_string()) }
    }
}

#[cfg(windows)]
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 { unsafe { windows::Win32::System::Com::CoUninitialize() }; }
    }
}

#[cfg(windows)]
fn tsf_manager() -> Result<(ComGuard, windows::Win32::UI::TextServices::ITfInputProcessorProfileMgr), String> {
    use windows::Win32::{System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER}, UI::TextServices::{CLSID_TF_InputProcessorProfiles, ITfInputProcessorProfileMgr}};
    let guard = ComGuard::initialize()?;
    let manager: ITfInputProcessorProfileMgr = unsafe { CoCreateInstance(&CLSID_TF_InputProcessorProfiles, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    Ok((guard, manager))
}

#[cfg(windows)]
fn current_tsf_profile() -> Option<StoredTsfProfile> {
    use windows::Win32::UI::TextServices::{GUID_TFCAT_TIP_KEYBOARD, TF_INPUTPROCESSORPROFILE};
    let (_guard, manager) = tsf_manager().ok()?;
    let mut profile = TF_INPUTPROCESSORPROFILE::default();
    unsafe { manager.GetActiveProfile(&GUID_TFCAT_TIP_KEYBOARD, &mut profile) }.ok()?;
    Some(store_tsf_profile(&profile))
}

#[cfg(windows)]
fn activate_tsf_profile(langid: u16) -> Result<(), String> {
    use windows::Win32::UI::TextServices::{GUID_TFCAT_TIP_KEYBOARD, TF_INPUTPROCESSORPROFILE, TF_IPP_FLAG_ENABLED, TF_PROFILETYPE_INPUTPROCESSOR};
    let (_guard, manager) = tsf_manager()?;
    let profiles = unsafe { manager.EnumProfiles(langid) }.map_err(|e| e.to_string())?;
    let mut keyboard_fallback = None;
    loop {
        let mut values = [TF_INPUTPROCESSORPROFILE::default()];
        let mut fetched = 0;
        unsafe { profiles.Next(&mut values, &mut fetched) }.map_err(|e| e.to_string())?;
        if fetched == 0 { break; }
        let profile = values[0];
        if profile.dwFlags & TF_IPP_FLAG_ENABLED == 0 || profile.catid != GUID_TFCAT_TIP_KEYBOARD { continue; }
        if profile.dwProfileType == TF_PROFILETYPE_INPUTPROCESSOR {
            return activate_tsf_exact(&store_tsf_profile(&profile));
        }
        keyboard_fallback.get_or_insert_with(|| store_tsf_profile(&profile));
    }
    keyboard_fallback.as_ref().ok_or_else(|| "no enabled TSF profile is installed".to_string()).and_then(activate_tsf_exact)
}

#[cfg(windows)]
fn activate_tsf_exact(profile: &StoredTsfProfile) -> Result<(), String> {
    use windows::Win32::{System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER}, UI::TextServices::{CLSID_TF_InputProcessorProfiles, ITfInputProcessorProfiles, TF_IPPMF_FORPROCESS}};
    use windows::Win32::UI::Input::KeyboardAndMouse::HKL;
    let (_guard, manager) = tsf_manager()?;
    let language_profiles: ITfInputProcessorProfiles = unsafe { CoCreateInstance(&CLSID_TF_InputProcessorProfiles, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    unsafe { language_profiles.ChangeCurrentLanguage(profile.langid) }.map_err(|e| e.to_string())?;
    unsafe { manager.ActivateProfile(profile.profile_type, profile.langid, &profile.clsid, &profile.guid, HKL(profile.hkl as *mut core::ffi::c_void), TF_IPPMF_FORPROCESS) }.map_err(|e| e.to_string())
}

#[cfg(windows)]
fn store_tsf_profile(profile: &windows::Win32::UI::TextServices::TF_INPUTPROCESSORPROFILE) -> StoredTsfProfile {
    let hkl = if profile.hkl.0.is_null() { profile.hklSubstitute } else { profile.hkl };
    StoredTsfProfile {
        profile_type: profile.dwProfileType,
        langid: profile.langid,
        clsid: profile.clsid,
        guid: profile.guidProfile,
        hkl: hkl.0 as usize,
    }
}

#[cfg(windows)]
fn load_layout(klid: &str) -> Result<usize, String> {
    use windows::{core::PCWSTR, Win32::UI::Input::KeyboardAndMouse::{ActivateKeyboardLayout, LoadKeyboardLayoutW, ACTIVATE_KEYBOARD_LAYOUT_FLAGS, KLF_ACTIVATE, KLF_SETFORPROCESS}};
    let wide: Vec<u16> = klid.encode_utf16().chain(std::iter::once(0)).collect();
    let flags = ACTIVATE_KEYBOARD_LAYOUT_FLAGS(KLF_ACTIVATE.0 | KLF_SETFORPROCESS.0);
    let hkl = unsafe { LoadKeyboardLayoutW(PCWSTR(wide.as_ptr()), flags) }.map_err(|e| e.to_string())?;
    if hkl.0.is_null() { return Err("layout is not installed".into()); }
    unsafe { ActivateKeyboardLayout(hkl, KLF_SETFORPROCESS) }.map_err(|e| e.to_string())?;
    Ok(hkl.0 as usize)
}

#[cfg(windows)]
fn activate_window_layout(hwnd: windows::Win32::Foundation::HWND, klid: &str) -> Result<(), String> {
    request_window_layout(hwnd, load_layout(klid)?)
}

#[cfg(windows)]
fn activate_layout(hkl: usize) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{ActivateKeyboardLayout, HKL, KLF_SETFORPROCESS};
    unsafe { ActivateKeyboardLayout(HKL(hkl as *mut core::ffi::c_void), KLF_SETFORPROCESS) }.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn request_window_layout(hwnd: windows::Win32::Foundation::HWND, hkl: usize) -> Result<(), String> {
    use windows::Win32::{Foundation::{LPARAM, WPARAM}, UI::WindowsAndMessaging::{PostMessageW, WM_INPUTLANGCHANGEREQUEST}};
    activate_layout(hkl)?;
    unsafe { PostMessageW(Some(hwnd), WM_INPUTLANGCHANGEREQUEST, WPARAM(0), LPARAM(hkl as isize)) }.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn focused_input_window(owner: windows::Win32::Foundation::HWND) -> windows::Win32::Foundation::HWND {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetGUIThreadInfo, GUITHREADINFO, GA_ROOT};
    let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
    if unsafe { GetGUIThreadInfo(0, &mut info) }.is_ok() && !info.hwndFocus.0.is_null() {
        let root = unsafe { GetAncestor(info.hwndFocus, GA_ROOT) };
        if root == owner { return info.hwndFocus; }
    }
    owner
}

#[cfg(windows)]
fn set_native_imm_mode(hwnd: windows::Win32::Foundation::HWND, language: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::Ime::{ImmGetContext, ImmReleaseContext, ImmSetConversionStatus, ImmSetOpenStatus, IME_CMODE_FULLSHAPE, IME_CMODE_NATIVE, IME_CMODE_ROMAN, IME_SENTENCE_MODE};
    let conversion = if language == "ja-JP" { IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE | IME_CMODE_ROMAN } else { IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE };
    let himc = unsafe { ImmGetContext(hwnd) };
    if !himc.0.is_null() {
        let opened = unsafe { ImmSetOpenStatus(himc, true) }.as_bool();
        let converted = unsafe { ImmSetConversionStatus(himc, conversion, IME_SENTENCE_MODE(0)) }.as_bool();
        unsafe { let _ = ImmReleaseContext(hwnd, himc); }
        if opened && converted { return Ok(()); }
    }
    set_native_mode_through_ime_window(hwnd, conversion.0)
}

#[cfg(windows)]
fn set_native_mode_through_ime_window(hwnd: windows::Win32::Foundation::HWND, conversion: u32) -> Result<(), String> {
    use windows::Win32::{Foundation::{LPARAM, WPARAM}, UI::{Input::Ime::{ImmGetDefaultIMEWnd, IMC_SETCONVERSIONMODE, IMC_SETOPENSTATUS}, WindowsAndMessaging::{SendMessageW, WM_IME_CONTROL}}};
    let ime_window = unsafe { ImmGetDefaultIMEWnd(hwnd) };
    if ime_window.0.is_null() { return Err("no default IME window is attached to the focused answer field".into()); }
    unsafe {
        SendMessageW(ime_window, WM_IME_CONTROL, Some(WPARAM(IMC_SETOPENSTATUS as usize)), Some(LPARAM(1)));
        SendMessageW(ime_window, WM_IME_CONTROL, Some(WPARAM(IMC_SETCONVERSIONMODE as usize)), Some(LPARAM(conversion as isize)));
    }
    Ok(())
}

#[cfg(windows)]
fn set_native_tsf_mode(language: &str) -> Result<(), String> {
    use std::mem::ManuallyDrop;
    use windows::Win32::{
        System::{
            Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4},
        },
        UI::TextServices::{
            CLSID_TF_ThreadMgr, GUID_COMPARTMENT_KEYBOARD_INPUTMODE_CONVERSION,
            GUID_COMPARTMENT_KEYBOARD_OPENCLOSE, ITfThreadMgr, TF_CONVERSIONMODE_FULLSHAPE,
            TF_CONVERSIONMODE_NATIVE, TF_CONVERSIONMODE_ROMAN,
        },
    };

    fn int_variant(value: i32) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 { lVal: value },
                }),
            },
        }
    }

    let _guard = ComGuard::initialize()?;
    let manager: ITfThreadMgr = unsafe { CoCreateInstance(&CLSID_TF_ThreadMgr, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    let client_id = unsafe { manager.Activate() }.map_err(|e| e.to_string())?;
    let result = (|| {
        let compartments = unsafe { manager.GetGlobalCompartment() }.map_err(|e| e.to_string())?;
        let open = unsafe { compartments.GetCompartment(&GUID_COMPARTMENT_KEYBOARD_OPENCLOSE) }.map_err(|e| e.to_string())?;
        let conversion = unsafe { compartments.GetCompartment(&GUID_COMPARTMENT_KEYBOARD_INPUTMODE_CONVERSION) }.map_err(|e| e.to_string())?;
        let open_value = int_variant(1);
        let conversion_mode = if language == "ja-JP" {
            TF_CONVERSIONMODE_NATIVE | TF_CONVERSIONMODE_FULLSHAPE | TF_CONVERSIONMODE_ROMAN
        } else {
            TF_CONVERSIONMODE_NATIVE | TF_CONVERSIONMODE_FULLSHAPE
        };
        let conversion_value = int_variant(conversion_mode as i32);
        unsafe { open.SetValue(client_id, &open_value) }.map_err(|e| e.to_string())?;
        unsafe { conversion.SetValue(client_id, &conversion_value) }.map_err(|e| e.to_string())
    })();
    let _ = unsafe { manager.Deactivate() };
    result
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "changes the active Windows input profile briefly"]
    fn windows_input_profile_smoke_restores_original_profile() {
        let mut adapter = WindowsInputAdapter::default();
        adapter.remember_current().unwrap();
        let window = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        let korean = adapter.activate_for_language("ko-KR", window);
        let japanese = adapter.activate_for_language("ja-JP", window);
        adapter.restore().unwrap();
        assert!(adapter.previous.is_none());
        assert!(adapter.active_language.is_none());
        eprintln!("ko-KR={korean:?}; ja-JP={japanese:?}");
    }
}
