import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SelectProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(1024)
  path!: string;
}
