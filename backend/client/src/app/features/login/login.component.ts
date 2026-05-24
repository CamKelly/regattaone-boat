import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzFormModule } from 'ng-zorro-antd/form';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login',
  imports: [
    ReactiveFormsModule,
    NzButtonModule,
    NzCardModule,
    NzFormModule,
    NzInputModule,
    NzTabsModule,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly message = inject(NzMessageService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly loading = { signIn: false, signUp: false };

  protected readonly signInForm = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  protected readonly signUpForm = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
    confirmPassword: ['', [Validators.required]],
  });

  protected async onSignIn(): Promise<void> {
    if (this.signInForm.invalid) {
      this.signInForm.markAllAsTouched();
      return;
    }

    this.loading.signIn = true;
    const { email, password } = this.signInForm.getRawValue();

    try {
      await this.authService.signIn(email, password);
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.message.error(this.readAuthError(error));
    } finally {
      this.loading.signIn = false;
    }
  }

  protected async onSignUp(): Promise<void> {
    if (this.signUpForm.invalid) {
      this.signUpForm.markAllAsTouched();
      return;
    }

    const { email, password, confirmPassword } = this.signUpForm.getRawValue();
    if (password !== confirmPassword) {
      this.message.error('Passwords do not match.');
      return;
    }

    this.loading.signUp = true;

    try {
      await this.authService.signUp(email, password);
      this.message.success('Account created. You are now signed in.');
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.message.error(this.readAuthError(error));
    } finally {
      this.loading.signUp = false;
    }
  }

  private readAuthError(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String((error as { code: string }).code);

      switch (code) {
        case 'auth/invalid-credential':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
          return 'Invalid email or password.';
        case 'auth/email-already-in-use':
          return 'An account with this email already exists.';
        case 'auth/weak-password':
          return 'Password must be at least 6 characters.';
        default:
          return 'Authentication failed. Please try again.';
      }
    }

    return 'Authentication failed. Please try again.';
  }
}
