import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Command overrides. Empty string clears a detected command ("do not run").
 * Omitted fields leave the previous override or detected value unchanged
 * when merged at the service layer via partial patch semantics.
 */
export class UpdateProjectCommandsDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  buildCommand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  testCommand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverageCommand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  e2eCommand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  startCommand?: string;
}
