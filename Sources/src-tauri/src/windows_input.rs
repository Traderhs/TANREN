#[derive(Debug, Default)]
pub struct WindowsInputAdapter {
    #[cfg(windows)]
    previous: Option<usize>,
}

impl WindowsInputAdapter {
    pub fn remember_current(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
            let hkl = unsafe { GetKeyboardLayout(0) };
            self.previous = Some(hkl.0 as usize);
        }
        Ok(())
    }

    pub fn activate_for_language(&mut self, language: &str) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows::{
                core::PCWSTR,
                Win32::UI::Input::{
                    Ime::{ImmGetContext, ImmReleaseContext, ImmSetConversionStatus, ImmSetOpenStatus, IME_CMODE_NATIVE, IME_CMODE_ROMAN, IME_SENTENCE_MODE},
                    KeyboardAndMouse::{ActivateKeyboardLayout, LoadKeyboardLayoutW, ACTIVATE_KEYBOARD_LAYOUT_FLAGS, KLF_ACTIVATE, KLF_SETFORPROCESS},
                },
                Win32::UI::WindowsAndMessaging::GetForegroundWindow,
            };

            let klid = match language {
                "ja-JP" => Some("00000411"),
                "ko-KR" => Some("00000412"),
                _ => None,
            };
            if let Some(klid) = klid {
                let wide: Vec<u16> = klid.encode_utf16().chain(std::iter::once(0)).collect();
                let flags = ACTIVATE_KEYBOARD_LAYOUT_FLAGS(KLF_ACTIVATE.0 | KLF_SETFORPROCESS.0);
                let hkl = unsafe { LoadKeyboardLayoutW(PCWSTR(wide.as_ptr()), flags) }.map_err(|e| e.to_string())?;
                if hkl.0.is_null() { return Err(format!("input profile {language} is not installed")); }
                unsafe { ActivateKeyboardLayout(hkl, KLF_SETFORPROCESS) }.map_err(|e| e.to_string())?;

                if language == "ja-JP" {
                    let hwnd = unsafe { GetForegroundWindow() };
                    let himc = unsafe { ImmGetContext(hwnd) };
                    if !himc.0.is_null() {
                        unsafe {
                            let _ = ImmSetOpenStatus(himc, true);
                            let _ = ImmSetConversionStatus(himc, IME_CMODE_NATIVE | IME_CMODE_ROMAN, IME_SENTENCE_MODE(0));
                            let _ = ImmReleaseContext(hwnd, himc);
                        }
                    }
                }
            }
        }
        #[cfg(not(windows))]
        let _ = language;
        Ok(())
    }

    pub fn restore(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::{ActivateKeyboardLayout, HKL, KLF_SETFORPROCESS};
            if let Some(raw) = self.previous.take() {
                unsafe { ActivateKeyboardLayout(HKL(raw as *mut core::ffi::c_void), KLF_SETFORPROCESS) }.map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
