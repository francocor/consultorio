# Delta for tenant-branding

Per-tenant name, logo and colors.

**Quick read**: no product or clinic name is hardcoded. Branding is configuration owned by the organization and never leaks across tenants.

## ADDED Requirements

### Requirement: Configurable organization identity

Each organization MUST have a display name, a logo and a color palette, set by its owner/admin. The product MUST NOT hardcode any customer name, logo or color in screens, titles, emails, documents or the installable-app metadata.

#### Scenario: Two tenants, two identities
- GIVEN organizations 1 and 2 with different names, logos and colors
- WHEN each member signs in
- THEN each sees only their organization's identity throughout the interface

#### Scenario: Default identity
- GIVEN a new organization that has not configured branding
- WHEN a member signs in
- THEN a neutral product default is shown with the organization's name once entered

### Requirement: Branding applies across surfaces

The organization's branding MUST apply to the sign-in screen, application shell, installable-app name and icon, transactional messages, generated PDFs and public pages that belong to the organization.

#### Scenario: Branded sign-in
- GIVEN a user opens the sign-in page of organization 1
- WHEN the page loads
- THEN it shows organization 1's identity
- AND it reveals nothing about other organizations

#### Scenario: Branded documents
- GIVEN a PDF is generated for organization 1
- WHEN it is produced
- THEN it carries organization 1's name and logo

### Requirement: Accessible color choices

The system MUST keep text and controls legible. If an organization's chosen colors would yield insufficient contrast, the system MUST warn the admin and MUST automatically apply an accessible adjusted variant to text and controls instead of rejecting the choice. The save MUST NOT be blocked by a contrast problem, the color the admin chose MUST be stored as chosen, and the adjusted result MUST be previewed before and after saving.

#### Scenario: Low-contrast palette
- GIVEN an admin picks a primary color with insufficient contrast against its text
- WHEN the admin saves
- THEN the system warns and uses an accessible adjusted variant for text
- AND the save succeeds with the chosen color retained

#### Scenario: Adjustment is previewed
- GIVEN an admin choosing a pale primary color
- WHEN the color picker changes
- THEN a preview shows the adjusted variant that will be applied
- AND a warning explains the adjustment

#### Scenario: Adequate palette untouched
- GIVEN a palette with sufficient contrast
- WHEN the admin saves
- THEN no adjustment is applied and no warning is shown

### Requirement: Logo upload safety

Logo uploads MUST accept only allowed image types within a size cap and MUST be validated server-side. Logos MUST be served without executing embedded content.

#### Scenario: Disallowed file
- GIVEN an admin uploads an executable or oversized file as a logo
- WHEN the server validates it
- THEN the upload is rejected with an es-AR message

### Requirement: Branding changes restricted and audited

Only owner/admin MAY change branding. Changes MUST be audited and MUST affect only that organization.

#### Scenario: Non-admin change
- GIVEN a reception user
- WHEN the user attempts to change the logo
- THEN the attempt is denied

#### Scenario: Branding does not alter authorization
- GIVEN any branding configuration
- WHEN permissions are evaluated
- THEN the outcome is identical
