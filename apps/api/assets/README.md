# API data assets

Static data the API loads at boot. They are bundled with the image (`infra/Dockerfile`) and are not secrets.

| File                        | Purpose                                                                                                    | Origin                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common-passwords-100k.txt` | The 100,000 most used passwords. The password policy rejects any password on it (identity-access, IDA-03). | `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` of [SecLists](https://github.com/danielmiessler/SecLists) (MIT), a list published by the UK National Cyber Security Centre. |

The list is held by the platform itself: a candidate password is never sent to a third party for this check.
